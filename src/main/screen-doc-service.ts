import { randomUUID } from 'crypto'
import { BrowserWindow, app, dialog } from 'electron'
import { EventEmitter } from 'events'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  ASR_DEFAULT_BASE_URL,
  POLISH_DEFAULT_BASE_URL,
  SCREEN_DOC_DEFAULT_PROMPT,
  type ScreenDocAnalysis,
  type ScreenDocHistoryRecord,
  type ScreenDocHistoryStatus,
  type ScreenDocResultPayload,
  type ScreenDocScreenshot,
  type ScreenDocStatus,
  type ScreenDocStatusPayload,
  type ScreenDocStep
} from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import { ASRClient } from './asr-client'
import type { ConfigStore } from './config-store'
import { getConfig, getScreenDocHistory, setScreenDocHistory } from './config-store'
import type {
  NativeScreenRecorderLike,
  NativeScreenRecordingArtifact
} from './native-screen-recorder'
import type { OverlayBackend } from './overlay-backend'

interface ScreenDocFrameInput {
  timestampMs: number
  dataUrl: string
}

interface ScreenDocServiceOptions {
  overlay: OverlayBackend
  configStore: ConfigStore
  screenRecorder: NativeScreenRecorderLike
}

interface DashScopeUploadPolicy {
  upload_dir: string
  oss_access_key_id: string
  signature: string
  policy: string
  x_oss_object_acl: string
  x_oss_forbid_overwrite: string
  upload_host: string
}

const SCREEN_DOC_MODEL = 'qwen3.5-plus'
const DASHSCOPE_UPLOAD_URL = 'https://dashscope.aliyuncs.com/api/v1/uploads'
const DEFAULT_FRAME_LIMIT = 48
const SCREEN_DOC_HISTORY_DIRNAME = 'screen-doc-history'

function isDashScopeBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes('dashscope.aliyuncs.com')
}

function clampTimestamp(value: number, durationMs: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(durationMs, Math.round(value)))
}

function sanitizeTitleSegment(input: string): string {
  const normalized = input.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-')
  return normalized || 'screen-doc'
}

function timestampLabel(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

function extractContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (typeof (item as { text?: unknown })?.text === 'string') {
          return String((item as { text: string }).text)
        }
        return ''
      })
      .join('')
  }
  return ''
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1)
  }
  return text.trim()
}

function nextSignificantChar(text: string, startIndex: number): string {
  for (let index = startIndex; index < text.length; index++) {
    const char = text[index]
    if (!/\s/.test(char)) {
      return char
    }
  }
  return ''
}

function stripTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/g, '$1')
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError'
}

function repairJsonLikeText(text: string): string {
  let repaired = ''
  let inString = false
  let quoteChar = '"'
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      if (escaped) {
        repaired += char
        escaped = false
        continue
      }

      if (char === '\\') {
        repaired += char
        escaped = true
        continue
      }

      if (char === '\n' || char === '\r') {
        repaired += '\\n'
        continue
      }

      if (char === quoteChar) {
        const next = nextSignificantChar(text, index + 1)
        const canClose = next === '' || next === ',' || next === '}' || next === ']' || next === ':'
        if (canClose) {
          repaired += '"'
          inString = false
        } else {
          repaired += '\\"'
        }
        continue
      }

      repaired += char
      continue
    }

    if (char === '"' || char === '\'') {
      inString = true
      quoteChar = char
      repaired += '"'
      continue
    }

    if (char === '}' || char === ']') {
      repaired = repaired.replace(/,\s*$/, '')
      repaired += char
      continue
    }

    repaired += char
  }

  return stripTrailingCommas(repaired)
}

function parseJsonWithRepair(rawText: string): unknown {
  const candidate = extractJsonObject(rawText)
  const attempts = [
    candidate,
    stripTrailingCommas(candidate),
    repairJsonLikeText(candidate)
  ]

  let lastError: unknown = null
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt)
    } catch (error) {
      lastError = error
    }
  }

  throw lastError instanceof Error ? lastError : new Error('无法解析模型返回的 JSON')
}

function sampleFrames(frames: ScreenDocFrameInput[], maxFrames: number): ScreenDocFrameInput[] {
  if (frames.length <= maxFrames) return frames

  const sampled: ScreenDocFrameInput[] = []
  for (let index = 0; index < maxFrames; index++) {
    const sourceIndex = Math.round((index / (maxFrames - 1)) * (frames.length - 1))
    sampled.push(frames[sourceIndex])
  }
  return sampled
}

function averageFrameFps(frames: ScreenDocFrameInput[], defaultIntervalMs: number): number {
  if (frames.length < 2) {
    return defaultIntervalMs > 0 ? Number((1000 / defaultIntervalMs).toFixed(2)) : 1
  }

  let totalDelta = 0
  for (let index = 1; index < frames.length; index++) {
    totalDelta += Math.max(1, frames[index].timestampMs - frames[index - 1].timestampMs)
  }

  const averageDelta = totalDelta / (frames.length - 1)
  return Number((1000 / averageDelta).toFixed(2))
}

function parseDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    throw new Error('无效的截图数据')
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64')
  }
}

export class ScreenDocService extends EventEmitter {
  private readonly overlay: OverlayBackend
  private readonly configStore: ConfigStore
  private readonly screenRecorder: NativeScreenRecorderLike
  private status: ScreenDocStatus = 'idle'
  private startedAt: number | undefined
  private error: string | undefined
  private partialTranscript = ''
  private finalTranscript = ''
  private latestResult: ScreenDocResultPayload | null = null
  private currentRecordId: string | null = null
  private historyFallback: ScreenDocHistoryRecord[] = []
  private asrClient: ASRClient | null = null
  private abortController: AbortController | null = null
  private runId = 0

  constructor(options: ScreenDocServiceOptions) {
    super()
    this.overlay = options.overlay
    this.configStore = options.configStore
    this.screenRecorder = options.screenRecorder
    this.screenRecorder.on('recording-error', (payload) => {
      const activeRecordId = this.currentRecordId
      if (this.status === 'recording') {
        this.runId += 1
        this.asrClient?.abort()
        this.asrClient = null
        this.abortController?.abort()
        this.abortController = null
        this.setStatus('error', payload.error || '原生录屏意外中断')
        this.overlay.hideHud()
        if (activeRecordId) {
          void this.updateHistoryRecord(activeRecordId, {
            status: 'error',
            error: payload.error || '原生录屏意外中断',
            title: '录屏整理失败'
          })
        }
      }
    })
  }

  getStatus(): ScreenDocStatus {
    return this.status
  }

  getStatusPayload(): ScreenDocStatusPayload {
    return {
      status: this.status,
      startedAt: this.startedAt,
      error: this.error,
      transcript: this.finalTranscript || this.partialTranscript,
      artifactId: this.currentRecordId || this.latestResult?.artifactId,
      stepCount: this.status === 'ready' ? this.latestResult?.analysis.steps.length : undefined,
      captureBackend: 'native'
    }
  }

  getLatestResult(): ScreenDocResultPayload | null {
    return this.latestResult
  }

  getHistoryList(): ScreenDocHistoryRecord[] {
    return this.getHistoryRecords()
  }

  async start(): Promise<{ ok: boolean; error?: string }> {
    if (process.platform !== 'darwin') {
      return { ok: false, error: '录屏整理首版仅支持 macOS' }
    }

    if (this.status !== 'idle' && this.status !== 'ready' && this.status !== 'error') {
      return { ok: false, error: '已有录屏整理任务正在进行' }
    }

    const config = getConfig(this.configStore)
    const llmApiKey = config.polishApiKey || config.asrApiKey
    if (!config.asrApiKey) {
      return { ok: false, error: '请先配置语音识别 API Key' }
    }
    if (!llmApiKey) {
      return { ok: false, error: '请先配置百炼 API Key' }
    }

    this.runId += 1
    this.abortController?.abort()
    this.abortController = null
    this.partialTranscript = ''
    this.finalTranscript = ''
    this.error = undefined
    this.latestResult = null
    this.currentRecordId = null
    this.startedAt = undefined
    this.overlay.hideHud()

    try {
      this.asrClient = new ASRClient(
        config.asrApiKey,
        config.asrModel,
        config.asrBaseUrl || ASR_DEFAULT_BASE_URL
      )

      this.asrClient.on('partial', (text: string) => {
        this.partialTranscript = text
        if (this.status === 'recording') {
          this.emitStatus()
        }
      })

      this.asrClient.once('completed', (text: string) => {
        this.finalTranscript = text.trim()
        this.emitStatus()
      })

      this.asrClient.on('error', (err: Error) => {
        console.warn('[ScreenDoc] ASR error:', err.message)
      })

      await this.asrClient.start()
      await this.screenRecorder.startRecording()
      this.currentRecordId = randomUUID()
      this.startedAt = Date.now()
      await this.updateHistoryRecord(this.currentRecordId, {
        id: this.currentRecordId,
        createdAt: this.startedAt,
        updatedAt: this.startedAt,
        status: 'recording',
        title: '录屏整理中'
      })
      this.setStatus('recording')
      return { ok: true }
    } catch (error) {
      console.error('[ScreenDoc] Failed to start:', error)
      try {
        await this.screenRecorder.cancelRecording()
      } catch {
        // Ignore secondary cancellation failures while surfacing the start error.
      }
      this.asrClient?.abort()
      this.asrClient = null
      const errorMessage = error instanceof Error ? error.message : '启动录屏整理失败'
      if (errorMessage.includes('已取消录屏对象选择')) {
        this.setStatus('idle')
      } else {
        this.setStatus('error', errorMessage)
      }
      this.overlay.hideHud()
      return { ok: false, error: errorMessage }
    }
  }

  requestStopCapture(): void {
    if (this.status !== 'recording') return
    void this.stop()
  }

  requestCancelCapture(): void {
    if (
      this.status !== 'recording' &&
      this.status !== 'finalizing' &&
      this.status !== 'uploading' &&
      this.status !== 'analyzing'
    ) {
      return
    }
    void this.cancel()
  }

  appendAudioChunk(chunk: Buffer): void {
    if (this.status !== 'recording' || !this.asrClient) return
    this.asrClient.appendAudio(chunk)
  }

  async stop(): Promise<ScreenDocResultPayload | null> {
    if (this.status !== 'recording') {
      return null
    }

    const currentRunId = this.runId
    const recordId = this.currentRecordId ?? randomUUID()
    this.currentRecordId = recordId
    const config = getConfig(this.configStore)
    const llmApiKey = config.polishApiKey || config.asrApiKey
    if (!llmApiKey) {
      await this.updateHistoryRecord(recordId, {
        status: 'error',
        error: '未找到可用的百炼 API Key',
        title: '录屏整理失败'
      })
      this.setStatus('error', '未找到可用的百炼 API Key')
      return null
    }

    this.setStatus('finalizing')
    await this.updateHistoryRecord(recordId, {
      status: 'finalizing',
      updatedAt: Date.now()
    })

    let recordingArtifact: NativeScreenRecordingArtifact | null = null
    let timelineFrames: ScreenDocFrameInput[] = []
    let frameIntervalMs = 1000

    try {
      recordingArtifact = await this.screenRecorder.stopRecording()
      if (this.runId !== currentRunId) return null

      await this.finishAsrTranscript()
      if (this.runId !== currentRunId) return null

      const transcript = (this.finalTranscript || this.partialTranscript).trim()
      let analysis: ScreenDocAnalysis | null = null

      const canUploadVideo = /^(video\/mp4|video\/quicktime|video\/x-msvideo|video\/x-matroska)$/i.test(recordingArtifact.mimeType)

      if (canUploadVideo) {
        this.setStatus('uploading')
        await this.updateHistoryRecord(recordId, {
          status: 'uploading',
          updatedAt: Date.now(),
          durationMs: recordingArtifact.durationMs
        })
        try {
          const bytes = await readFile(recordingArtifact.filePath)
          const ossUrl = await this.uploadTemporaryFile(
            llmApiKey,
            SCREEN_DOC_MODEL,
            basename(recordingArtifact.filePath),
            recordingArtifact.mimeType,
            bytes
          )
          if (this.runId !== currentRunId) return null
          this.setStatus('analyzing')
          await this.updateHistoryRecord(recordId, {
            status: 'analyzing',
            updatedAt: Date.now(),
            durationMs: recordingArtifact.durationMs
          })
          analysis = await this.analyzeWithVideo(
            llmApiKey,
            config.polishBaseUrl || POLISH_DEFAULT_BASE_URL,
            ossUrl,
            transcript,
            recordingArtifact.durationMs,
            recordingArtifact.targetDescription,
            config.screenDocPrompt
          )
        } catch (error) {
          if (this.runId !== currentRunId || isAbortError(error)) {
            throw error
          }
          console.warn('[ScreenDoc] Video upload or analysis failed, falling back to frames:', error)
        }
      }

      if (this.runId !== currentRunId) return null

      if (!analysis) {
        this.setStatus('analyzing')
        await this.updateHistoryRecord(recordId, {
          status: 'analyzing',
          updatedAt: Date.now(),
          durationMs: recordingArtifact.durationMs
        })
        const timelineResult = await this.screenRecorder.extractTimelineFrames(
          recordingArtifact.filePath,
          1000,
          DEFAULT_FRAME_LIMIT
        )
        timelineFrames = timelineResult.frames
        frameIntervalMs = timelineResult.intervalMs
        analysis = await this.analyzeWithFrames(
          llmApiKey,
          config.polishBaseUrl || POLISH_DEFAULT_BASE_URL,
          timelineFrames,
          frameIntervalMs,
          transcript,
          recordingArtifact.durationMs,
          recordingArtifact.targetDescription,
          config.screenDocPrompt
        )
      }

      if (this.runId !== currentRunId) return null

      const screenshots = await this.buildScreenshotsForSteps(
        recordingArtifact.filePath,
        analysis.steps,
        timelineFrames
      )
      const artifactId = recordId
      const previewMarkdown = this.buildMarkdown(analysis, screenshots, true)
      const result: ScreenDocResultPayload = {
        artifactId,
        analysis,
        screenshots,
        markdown: previewMarkdown,
        createdAt: Date.now()
      }

      this.latestResult = result
      await this.persistHistoryRecord({
        id: recordId,
        createdAt: this.startedAt ?? result.createdAt,
        updatedAt: result.createdAt,
        status: 'ready',
        title: analysis.title,
        summary: analysis.summary,
        stepCount: analysis.steps.length,
        durationMs: recordingArtifact.durationMs,
        analysis,
        screenshots,
        markdown: previewMarkdown,
        transcript: analysis.transcript
      })
      this.overlay.hideHud()
      this.setStatus('ready')
      return result
    } catch (error) {
      console.error('[ScreenDoc] Failed to finalize recording:', error)
      if (this.runId === currentRunId) {
        this.overlay.hideHud()
        const errorMessage = error instanceof Error ? error.message : '录屏整理失败'
        await this.updateHistoryRecord(recordId, {
          status: 'error',
          error: errorMessage,
          updatedAt: Date.now(),
          durationMs: recordingArtifact?.durationMs,
          title: '录屏整理失败'
        })
        this.setStatus('error', errorMessage)
      }
      return null
    } finally {
      if (recordingArtifact?.filePath) {
        await rm(recordingArtifact.filePath, { force: true }).catch(() => undefined)
      }
      this.asrClient?.abort()
      this.asrClient = null
      this.abortController = null
    }
  }

  async cancel(): Promise<void> {
    const shouldMarkCancelled =
      this.status === 'recording' ||
      this.status === 'finalizing' ||
      this.status === 'uploading' ||
      this.status === 'analyzing'
    const recordId = shouldMarkCancelled ? this.currentRecordId : null
    this.runId += 1
    this.abortController?.abort()
    this.abortController = null
    try {
      await this.screenRecorder.cancelRecording()
    } catch {
      // Ignore cancellation races when the native recorder is already idle.
    }
    this.asrClient?.abort()
    this.asrClient = null
    this.partialTranscript = ''
    this.finalTranscript = ''
    this.error = undefined
    this.overlay.hideHud()
    if (recordId) {
      await this.updateHistoryRecord(recordId, {
        status: 'cancelled',
        updatedAt: Date.now(),
        title: '已取消的录屏整理'
      })
    }
    this.setStatus('idle')
  }

  destroy(): void {
    void this.cancel()
    this.screenRecorder.destroy()
  }

  async exportRecord(recordId?: string): Promise<string | null> {
    const resolvedRecordId = recordId || this.latestResult?.artifactId
    if (!resolvedRecordId) {
      return null
    }

    const record = await this.getHistoryRecord(resolvedRecordId)
    if (!record || record.status !== 'ready' || !record.analysis || !record.screenshots || !record.markdown) {
      throw new Error('该记录还没有可导出的整理结果')
    }

    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出目录'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const baseDir = result.filePaths[0]
    const timeLabel = new Date(record.createdAt).toISOString().replace(/[:.]/g, '-')
    const exportDir = join(baseDir, `${sanitizeTitleSegment(record.title)}-${timeLabel}`)
    const assetsDir = join(exportDir, 'assets')
    await mkdir(assetsDir, { recursive: true })

    const assetPaths = record.screenshots.map((screenshot, index) => {
      const filename = `step-${String(index + 1).padStart(2, '0')}.png`
      return { ...screenshot, filename, relativePath: `assets/${filename}` }
    })

    for (const asset of assetPaths) {
      const parsed = parseDataUrl(asset.dataUrl)
      await writeFile(join(exportDir, asset.relativePath), parsed.buffer)
    }

    const markdown = this.buildMarkdown(record.analysis, assetPaths, false)
    await writeFile(join(exportDir, 'doc.md'), markdown, 'utf8')
    return exportDir
  }

  private emitStatus(): void {
    const payload = this.getStatusPayload()
    this.emit('status', payload)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.SCREEN_DOC_STATUS, payload)
      }
    }
  }

  private setStatus(status: ScreenDocStatus, error?: string): void {
    this.status = status
    this.error = error
    if (status === 'idle') {
      this.startedAt = undefined
    }
    this.emitStatus()
  }

  private async finishAsrTranscript(): Promise<void> {
    if (!this.asrClient) return
    try {
      await this.asrClient.finish()
    } catch (error) {
      console.warn('[ScreenDoc] finishAsrTranscript failed, falling back to partial transcript:', error)
    }
    if (!this.finalTranscript.trim()) {
      this.finalTranscript = this.partialTranscript.trim()
    }
  }

  private async getUploadPolicy(apiKey: string, model: string): Promise<DashScopeUploadPolicy> {
    const url = new URL(DASHSCOPE_UPLOAD_URL)
    url.searchParams.set('action', 'getPolicy')
    url.searchParams.set('model', model)
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      throw new Error(`获取上传凭证失败: ${await response.text()}`)
    }

    const body = await response.json() as { data?: DashScopeUploadPolicy }
    if (!body.data) {
      throw new Error('上传凭证响应缺少 data 字段')
    }
    return body.data
  }

  private async uploadTemporaryFile(
    apiKey: string,
    model: string,
    fileName: string,
    mimeType: string,
    bytes: Buffer
  ): Promise<string> {
    const policy = await this.getUploadPolicy(apiKey, model)
    const key = `${policy.upload_dir}/${sanitizeTitleSegment(fileName)}`
    const formData = new FormData()
    const uploadBytes = Uint8Array.from(bytes)
    formData.set('OSSAccessKeyId', policy.oss_access_key_id)
    formData.set('Signature', policy.signature)
    formData.set('policy', policy.policy)
    formData.set('x-oss-object-acl', policy.x_oss_object_acl)
    formData.set('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite)
    formData.set('key', key)
    formData.set('success_action_status', '200')
    formData.set('file', new Blob([uploadBytes], { type: mimeType }), fileName)

    const response = await fetch(policy.upload_host, {
      method: 'POST',
      body: formData
    })

    if (!response.ok) {
      throw new Error(`上传录屏文件失败: ${await response.text()}`)
    }

    return `oss://${key}`
  }

  private async analyzeWithVideo(
    apiKey: string,
    baseUrl: string,
    ossUrl: string,
    transcript: string,
    durationMs: number,
    targetDescription: string | undefined,
    promptTemplate: string
  ): Promise<ScreenDocAnalysis> {
    const resolvedBaseUrl = isDashScopeBaseUrl(baseUrl) ? baseUrl : POLISH_DEFAULT_BASE_URL
    return await this.analyzeMultimodal(
      apiKey,
      resolvedBaseUrl,
      [
        {
          type: 'video_url',
          video_url: { url: ossUrl },
          fps: durationMs <= 90_000 ? 2 : 1
        },
        {
          type: 'text',
          text: this.buildUserPrompt(promptTemplate, transcript, durationMs, targetDescription)
        }
      ],
      true,
      durationMs
    )
  }

  private async analyzeWithFrames(
    apiKey: string,
    baseUrl: string,
    frames: ScreenDocFrameInput[],
    frameIntervalMs: number,
    transcript: string,
    durationMs: number,
    targetDescription: string | undefined,
    promptTemplate: string
  ): Promise<ScreenDocAnalysis> {
    if (frames.length === 0) {
      throw new Error('缺少关键帧，无法回退到图像列表分析')
    }

    const sampledFrames = sampleFrames(frames, DEFAULT_FRAME_LIMIT)
    const fps = averageFrameFps(sampledFrames, frameIntervalMs)
    return await this.analyzeMultimodal(
      apiKey,
      isDashScopeBaseUrl(baseUrl) ? baseUrl : POLISH_DEFAULT_BASE_URL,
      [
        {
          type: 'video',
          video: sampledFrames.map((frame) => frame.dataUrl),
          fps
        },
        {
          type: 'text',
          text: this.buildUserPrompt(promptTemplate, transcript, durationMs, targetDescription)
        }
      ],
      false,
      durationMs
    )
  }

  private buildUserPrompt(
    promptTemplate: string,
    transcript: string,
    durationMs: number,
    targetDescription?: string
  ): string {
    const safeTranscript = transcript.trim() || '（本次没有识别到清晰的语音说明）'
    const template = promptTemplate.trim() || SCREEN_DOC_DEFAULT_PROMPT
    return template
      .replaceAll('{duration_seconds}', String(Math.max(1, Math.round(durationMs / 1000))))
      .replaceAll('{duration_ms}', String(Math.max(0, Math.round(durationMs))))
      .replaceAll('{transcript}', safeTranscript)
      .replaceAll('{target_description}', targetDescription?.trim() || '未提供录屏对象描述')
  }

  private async analyzeMultimodal(
    apiKey: string,
    baseUrl: string,
    content: Array<Record<string, unknown>>,
    usesOssResource: boolean,
    durationMs: number
  ): Promise<ScreenDocAnalysis> {
    this.abortController?.abort()
    this.abortController = new AbortController()

    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: this.abortController.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(usesOssResource ? { 'X-DashScope-OssResourceResolve': 'enable' } : {})
      },
      body: JSON.stringify({
        model: SCREEN_DOC_MODEL,
        temperature: 0.2,
        messages: [
          {
            role: 'system',
            content: '你是一名产品文档助手，擅长把软件操作录屏整理成结构清晰、可复用的中文 SOP 文档。'
          },
          {
            role: 'user',
            content
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`录屏分析失败: ${await response.text()}`)
    }

    const body = await response.json() as {
      choices?: Array<{
        message?: {
          content?: unknown
        }
      }>
    }
    const rawContent = body.choices?.[0]?.message?.content
    const text = extractContentText(rawContent)
    if (!text.trim()) {
      throw new Error('模型未返回有效的整理结果')
    }

    return this.normalizeAnalysis(text, durationMs)
  }

  private normalizeAnalysis(rawText: string, durationMs: number): ScreenDocAnalysis {
    const parsed = parseJsonWithRepair(rawText) as Partial<ScreenDocAnalysis> & {
      steps?: Array<Partial<ScreenDocStep>>
      notes?: unknown
    }

    const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : []
    const steps: ScreenDocStep[] = rawSteps
      .map((step, index) => ({
        title: String(step.title || `步骤 ${index + 1}`).trim() || `步骤 ${index + 1}`,
        description: String(step.description || '').trim(),
        timestampMs: clampTimestamp(Number(step.timestampMs ?? 0), durationMs),
        screenshotTimestampMs: clampTimestamp(
          Number(step.screenshotTimestampMs ?? step.timestampMs ?? 0),
          durationMs
        )
      }))
      .filter((step) => step.description)

    if (steps.length === 0) {
      throw new Error('模型返回的步骤为空，无法生成文档')
    }

    return {
      title: String(parsed.title || '录屏整理结果').trim() || '录屏整理结果',
      summary: String(parsed.summary || '').trim() || '本次录屏整理已完成。',
      steps,
      notes: Array.isArray(parsed.notes)
        ? parsed.notes.map((item) => String(item).trim()).filter(Boolean)
        : [],
      transcript: String(parsed.transcript || this.finalTranscript || this.partialTranscript).trim()
    }
  }

  private pickScreenshotsForSteps(steps: ScreenDocStep[], frames: ScreenDocFrameInput[]): ScreenDocScreenshot[] {
    if (frames.length === 0) {
      return steps.map((step, index) => ({
        stepIndex: index,
        timestampMs: step.screenshotTimestampMs,
        dataUrl: ''
      }))
    }

    return steps.map((step, index) => {
      const nearest = frames.reduce((best, current) => {
        if (!best) return current
        const bestDistance = Math.abs(best.timestampMs - step.screenshotTimestampMs)
        const currentDistance = Math.abs(current.timestampMs - step.screenshotTimestampMs)
        return currentDistance < bestDistance ? current : best
      }, frames[0])

      return {
        stepIndex: index,
        timestampMs: nearest.timestampMs,
        dataUrl: nearest.dataUrl
      }
    })
  }

  private async buildScreenshotsForSteps(
    filePath: string,
    steps: ScreenDocStep[],
    fallbackFrames: ScreenDocFrameInput[]
  ): Promise<ScreenDocScreenshot[]> {
    try {
      const extracted = await this.screenRecorder.extractScreenshots(
        filePath,
        steps.map((step) => step.screenshotTimestampMs)
      )

      if (extracted.length === steps.length) {
        return extracted.map((screenshot, index) => ({
          stepIndex: index,
          timestampMs: screenshot.timestampMs,
          dataUrl: screenshot.dataUrl
        }))
      }

      if (extracted.length > 0) {
        const extractedFrames = extracted.map((frame) => ({
          timestampMs: frame.timestampMs,
          dataUrl: frame.dataUrl
        }))
        return this.pickScreenshotsForSteps(steps, extractedFrames)
      }
    } catch (error) {
      console.warn('[ScreenDoc] Failed to extract screenshots from native recorder:', error)
    }

    return this.pickScreenshotsForSteps(steps, fallbackFrames)
  }

  private buildMarkdown(
    analysis: ScreenDocAnalysis,
    screenshots: Array<ScreenDocScreenshot & { relativePath?: string }>,
    inlineImages: boolean
  ): string {
    const lines: string[] = [
      `# ${analysis.title}`,
      '',
      analysis.summary,
      ''
    ]

    if (analysis.notes.length > 0) {
      lines.push('## 补充说明', '')
      for (const note of analysis.notes) {
        lines.push(`- ${note}`)
      }
      lines.push('')
    }

    lines.push('## 操作步骤', '')
    analysis.steps.forEach((step, index) => {
      const screenshot = screenshots[index]
      lines.push(`### ${index + 1}. ${step.title}`, '')
      lines.push(`时间点：${timestampLabel(step.timestampMs)}`, '')
      if (screenshot?.dataUrl || screenshot?.relativePath) {
        const imageRef = inlineImages
          ? screenshot.dataUrl
          : screenshot.relativePath
        if (imageRef) {
          lines.push(`![${step.title}](${imageRef})`, '')
        }
      }
      lines.push(step.description, '')
    })

    if (analysis.transcript.trim()) {
      lines.push('## 语音说明摘录', '', analysis.transcript.trim(), '')
    }

    return lines.join('\n').trim()
  }

  async getHistoryRecord(recordId: string): Promise<ScreenDocHistoryRecord | null> {
    const summary = this.getHistoryRecords().find((record) => record.id === recordId) || null
    if (!summary) {
      return null
    }

    const persisted = await this.loadPersistedRecord(recordId)
    return persisted || summary
  }

  async pruneHistory(maxCount = getConfig(this.configStore).screenDocHistoryMaxCount): Promise<void> {
    const records = this.getHistoryRecords()
    if (records.length <= maxCount) {
      return
    }

    const keep = records.slice(0, maxCount)
    const remove = records.slice(maxCount)
    this.saveHistoryRecords(keep)
    await Promise.all(remove.map((record) => this.removePersistedRecord(record.id)))
  }

  private getHistoryRecords(): ScreenDocHistoryRecord[] {
    const source = (() => {
      try {
        return getScreenDocHistory(this.configStore)
      } catch {
        return this.historyFallback
      }
    })()

    return [...source].sort((left, right) => right.updatedAt - left.updatedAt)
  }

  private saveHistoryRecords(records: ScreenDocHistoryRecord[]): void {
    this.historyFallback = [...records]
    try {
      setScreenDocHistory(this.configStore, records)
    } catch {
      // The electron-store singleton is initialized in the real app. Tests and
      // early boot paths can fall back to the in-memory index safely.
    }
    this.emitHistoryUpdated()
  }

  private emitHistoryUpdated(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.SCREEN_DOC_HISTORY_UPDATED)
      }
    }
  }

  private async updateHistoryRecord(
    recordId: string,
    updates: Partial<ScreenDocHistoryRecord> & Pick<ScreenDocHistoryRecord, 'status'>
  ): Promise<ScreenDocHistoryRecord> {
    const records = this.getHistoryRecords()
    const index = records.findIndex((record) => record.id === recordId)
    const now = updates.updatedAt ?? Date.now()
    const baseRecord: ScreenDocHistoryRecord = index >= 0
      ? records[index]
      : {
          id: recordId,
          createdAt: this.startedAt ?? now,
          updatedAt: now,
          status: updates.status,
          title: this.defaultHistoryTitle(updates.status)
        }

    const nextRecord: ScreenDocHistoryRecord = {
      id: recordId,
      createdAt: updates.createdAt ?? baseRecord.createdAt,
      updatedAt: now,
      status: updates.status,
      title: updates.title?.trim() || baseRecord.title || this.defaultHistoryTitle(updates.status),
      summary: updates.summary ?? baseRecord.summary,
      stepCount: updates.stepCount ?? baseRecord.stepCount,
      durationMs: updates.durationMs ?? baseRecord.durationMs,
      error: updates.status === 'error'
        ? (updates.error ?? baseRecord.error)
        : updates.error
    }

    if (index >= 0) {
      records.splice(index, 1)
    }
    records.unshift(nextRecord)
    this.saveHistoryRecords(records)
    await this.pruneHistory()
    return nextRecord
  }

  private async persistHistoryRecord(record: ScreenDocHistoryRecord): Promise<void> {
    await this.writePersistedRecord(record)
    await this.updateHistoryRecord(record.id, record)
  }

  private defaultHistoryTitle(status: ScreenDocHistoryStatus): string {
    switch (status) {
      case 'recording':
        return '录屏整理中'
      case 'finalizing':
        return '正在封装录屏'
      case 'uploading':
        return '正在上传录屏'
      case 'analyzing':
        return '正在整理步骤文档'
      case 'ready':
        return '录屏整理结果'
      case 'cancelled':
        return '已取消的录屏整理'
      case 'error':
        return '录屏整理失败'
    }
  }

  private getHistoryRootDir(): string {
    return join(app.getPath('userData'), SCREEN_DOC_HISTORY_DIRNAME)
  }

  private getHistoryArtifactsDir(): string {
    return join(this.getHistoryRootDir(), 'artifacts')
  }

  private getRecordDir(recordId: string): string {
    return join(this.getHistoryArtifactsDir(), recordId)
  }

  private getRecordFilePath(recordId: string): string {
    return join(this.getRecordDir(recordId), 'record.json')
  }

  private async writePersistedRecord(record: ScreenDocHistoryRecord): Promise<void> {
    const recordDir = this.getRecordDir(record.id)
    const assetsDir = join(recordDir, 'assets')
    await mkdir(assetsDir, { recursive: true })

    const screenshots = record.screenshots ?? []
    const assetPaths = screenshots.map((screenshot, index) => {
      const filename = `step-${String(index + 1).padStart(2, '0')}.png`
      return { ...screenshot, relativePath: `assets/${filename}` }
    })

    for (const asset of assetPaths) {
      const parsed = parseDataUrl(asset.dataUrl)
      await writeFile(join(recordDir, asset.relativePath), parsed.buffer)
    }

    const markdown = record.analysis
      ? this.buildMarkdown(record.analysis, assetPaths, false)
      : record.markdown

    if (markdown) {
      await writeFile(join(recordDir, 'doc.md'), markdown, 'utf8')
    }

    await writeFile(
      this.getRecordFilePath(record.id),
      JSON.stringify(
        {
          ...record,
          markdown: record.markdown ?? markdown
        },
        null,
        2
      ),
      'utf8'
    )
  }

  private async loadPersistedRecord(recordId: string): Promise<ScreenDocHistoryRecord | null> {
    try {
      const content = await readFile(this.getRecordFilePath(recordId), 'utf8')
      return JSON.parse(content) as ScreenDocHistoryRecord
    } catch {
      return null
    }
  }

  private async removePersistedRecord(recordId: string): Promise<void> {
    await rm(this.getRecordDir(recordId), { recursive: true, force: true }).catch(() => undefined)
  }
}
