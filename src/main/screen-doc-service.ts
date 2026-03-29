import { randomUUID } from 'crypto'
import { BrowserWindow, dialog } from 'electron'
import { EventEmitter } from 'events'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { basename, join } from 'path'
import {
  ASR_DEFAULT_BASE_URL,
  POLISH_DEFAULT_BASE_URL,
  type OverlayHudPayload,
  type OverlayWindowPosition,
  type OverlayWindowSize,
  type ScreenDocAnalysis,
  type ScreenDocResultPayload,
  type ScreenDocScreenshot,
  type ScreenDocStatus,
  type ScreenDocStatusPayload,
  type ScreenDocStep
} from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import { ASRClient } from './asr-client'
import { createAssistantResultWindow, getLatestAssistantResultPayload, hideAssistantResultWindow, showAssistantResultWindow } from './assistant-result-window'
import type { ConfigStore } from './config-store'
import { getConfig } from './config-store'
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
  getAssistantResultWindow: () => BrowserWindow | null
  setAssistantResultWindow: (window: BrowserWindow | null) => void
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
  private readonly getAssistantResultWindow: () => BrowserWindow | null
  private readonly setAssistantResultWindow: (window: BrowserWindow | null) => void
  private status: ScreenDocStatus = 'idle'
  private startedAt: number | undefined
  private error: string | undefined
  private partialTranscript = ''
  private finalTranscript = ''
  private latestResult: ScreenDocResultPayload | null = null
  private asrClient: ASRClient | null = null
  private abortController: AbortController | null = null
  private runId = 0

  constructor(options: ScreenDocServiceOptions) {
    super()
    this.overlay = options.overlay
    this.configStore = options.configStore
    this.screenRecorder = options.screenRecorder
    this.getAssistantResultWindow = options.getAssistantResultWindow
    this.setAssistantResultWindow = options.setAssistantResultWindow
    this.screenRecorder.on('recording-error', (payload) => {
      if (this.status === 'recording') {
        this.runId += 1
        this.asrClient?.abort()
        this.asrClient = null
        this.abortController?.abort()
        this.abortController = null
        this.setStatus('error', payload.error || '原生录屏意外中断')
        this.overlay.hideHud()
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
      artifactId: this.latestResult?.artifactId,
      stepCount: this.latestResult?.analysis.steps.length,
      captureBackend: 'native'
    }
  }

  getLatestResult(): ScreenDocResultPayload | null {
    return this.latestResult
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
    this.startedAt = undefined
    this.overlay.hideResult()

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
      this.startedAt = Date.now()
      this.setStatus('recording')
      this.showHud('正在录屏并同步语音说明...', 'recording')
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
    if (this.status !== 'recording' && this.status !== 'finalizing') {
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
    const config = getConfig(this.configStore)
    const llmApiKey = config.polishApiKey || config.asrApiKey
    if (!llmApiKey) {
      this.setStatus('error', '未找到可用的百炼 API Key')
      return null
    }

    this.setStatus('finalizing')
    this.showHud('正在整理录屏和语音转写...', 'processing')

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
        this.showHud('正在上传录屏文件...', 'processing')
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
          this.showHud('Qwen 正在分析操作过程...', 'processing')
          analysis = await this.analyzeWithVideo(
            llmApiKey,
            config.polishBaseUrl || POLISH_DEFAULT_BASE_URL,
            ossUrl,
            transcript,
            recordingArtifact.durationMs
          )
        } catch (error) {
          console.warn('[ScreenDoc] Video upload or analysis failed, falling back to frames:', error)
        }
      }

      if (!analysis) {
        this.setStatus('analyzing')
        this.showHud('正在回退为关键帧分析...', 'processing')
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
          recordingArtifact.durationMs
        )
      }

      if (this.runId !== currentRunId) return null

      const screenshots = await this.buildScreenshotsForSteps(
        recordingArtifact.filePath,
        analysis.steps,
        timelineFrames
      )
      const artifactId = randomUUID()
      const previewMarkdown = this.buildMarkdown(analysis, screenshots, true)
      const result: ScreenDocResultPayload = {
        artifactId,
        analysis,
        screenshots,
        markdown: previewMarkdown,
        createdAt: Date.now()
      }

      this.latestResult = result
      this.showResult(result)
      this.overlay.hideHud()
      this.setStatus('ready')
      return result
    } catch (error) {
      console.error('[ScreenDoc] Failed to finalize recording:', error)
      if (this.runId === currentRunId) {
        this.overlay.hideHud()
        this.setStatus('error', error instanceof Error ? error.message : '录屏整理失败')
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
    this.setStatus('idle')
  }

  destroy(): void {
    void this.cancel()
    this.screenRecorder.destroy()
  }

  async exportLatestResult(artifactId?: string): Promise<string | null> {
    if (!this.latestResult) {
      return null
    }
    if (artifactId && this.latestResult.artifactId !== artifactId) {
      throw new Error('结果已过期，请重新生成后再导出')
    }

    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: '选择导出目录'
    })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }

    const baseDir = result.filePaths[0]
    const timeLabel = new Date(this.latestResult.createdAt).toISOString().replace(/[:.]/g, '-')
    const exportDir = join(baseDir, `${sanitizeTitleSegment(this.latestResult.analysis.title)}-${timeLabel}`)
    const assetsDir = join(exportDir, 'assets')
    await mkdir(assetsDir, { recursive: true })

    const assetPaths = this.latestResult.screenshots.map((screenshot, index) => {
      const filename = `step-${String(index + 1).padStart(2, '0')}.png`
      return { ...screenshot, filename, relativePath: `assets/${filename}` }
    })

    for (const asset of assetPaths) {
      const parsed = parseDataUrl(asset.dataUrl)
      await writeFile(join(exportDir, asset.relativePath), parsed.buffer)
    }

    const markdown = this.buildMarkdown(this.latestResult.analysis, assetPaths, false)
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

  private showHud(text: string, mode: OverlayHudPayload['mode']): void {
    this.overlay.updateHud({
      text,
      mode,
      voiceMode: 'screen_doc',
      screenshotActive: false
    })
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
    durationMs: number
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
          text: this.buildUserPrompt(transcript, durationMs)
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
    durationMs: number
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
          text: this.buildUserPrompt(transcript, durationMs)
        }
      ],
      false,
      durationMs
    )
  }

  private buildUserPrompt(transcript: string, durationMs: number): string {
    return [
      '请根据这段录屏整理一份步骤式 SOP 文档。',
      '你会同时看到录屏画面和一份独立的语音转写文本；视频文件中的音轨不要作为理解依据，优先结合画面与转写文本。',
      '请严格输出 JSON，不要输出 Markdown，不要输出解释。',
      'JSON 结构如下：',
      '{',
      '  "title": "文档标题",',
      '  "summary": "一句到三句摘要",',
      '  "notes": ["补充说明，可为空数组"],',
      '  "steps": [',
      '    {',
      '      "title": "步骤标题",',
      '      "description": "详细说明，包含用户的关键操作与语音说明",',
      '      "timestampMs": 12000,',
      '      "screenshotTimestampMs": 12500',
      '    }',
      '  ]',
      '}',
      `录屏总时长约 ${Math.max(1, Math.round(durationMs / 1000))} 秒。`,
      '要求：',
      '1. 步骤保持 3 到 8 步，覆盖完整操作流程。',
      '2. timestampMs 和 screenshotTimestampMs 必须使用毫秒整数，并且位于视频时长范围内。',
      '3. 标题和描述使用中文，描述要明确指出用户点击、输入、切换或确认了什么。',
      '4. 如果语音转写提供了操作目的或注意事项，请合并到对应步骤描述里。',
      '5. 如果没有足够证据，不要编造。notes 可以写“未观察到”之类的说明。',
      '',
      '以下是独立的语音转写文本：',
      transcript.trim() || '（本次没有识别到清晰的语音说明）'
    ].join('\n')
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
    const parsed = JSON.parse(extractJsonObject(rawText)) as Partial<ScreenDocAnalysis> & {
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

  private showResult(result: ScreenDocResultPayload): void {
    const resultWindow = this.getOrCreateResultWindow()
    if (!resultWindow || resultWindow.isDestroyed()) return

    showAssistantResultWindow(resultWindow, {
      text: result.markdown,
      resultKind: 'screen_doc',
      title: result.analysis.title,
      eyebrow: '录屏整理',
      exportArtifactId: result.artifactId
    })
  }

  private getOrCreateResultWindow(): BrowserWindow | null {
    const existing = this.getAssistantResultWindow()
    if (existing && !existing.isDestroyed()) {
      return existing
    }

    const created = createAssistantResultWindow()
    this.setAssistantResultWindow(created)
    return created
  }

  handleResultWindowClosed(position?: OverlayWindowPosition, size?: OverlayWindowSize): void {
    const resultWindow = this.getAssistantResultWindow()
    if (!resultWindow || resultWindow.isDestroyed()) {
      return
    }

    const payload = getLatestAssistantResultPayload(resultWindow)
    if (payload?.resultKind === 'screen_doc') {
      hideAssistantResultWindow(resultWindow)
      return
    }

    if (position || size) {
      this.emit('result-window-closed', { position, size })
    }
  }
}
