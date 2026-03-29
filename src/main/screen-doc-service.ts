import { randomUUID } from 'crypto'
import { BrowserWindow, app, dialog } from 'electron'
import { EventEmitter } from 'events'
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, extname, join } from 'path'
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
const PREVIEW_HTML_FILE = 'preview.html'
const EXPORT_HTML_FILE = 'doc.html'
const EXPORT_MARKDOWN_FILE = 'doc.md'
const RECORD_FILE = 'record.json'
const RECORDING_FILE_BASENAME = 'recording'

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

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case 'video/mp4':
      return '.mp4'
    case 'video/quicktime':
      return '.mov'
    case 'video/x-msvideo':
      return '.avi'
    case 'video/x-matroska':
      return '.mkv'
    case 'video/webm':
      return '.webm'
    default:
      return ''
  }
}

function mimeTypeForFilePath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.mp4':
      return 'video/mp4'
    case '.mov':
      return 'video/quicktime'
    case '.avi':
      return 'video/x-msvideo'
    case '.mkv':
      return 'video/x-matroska'
    case '.webm':
      return 'video/webm'
    default:
      return 'application/octet-stream'
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\'', '&#39;')
}

function formatDurationLabel(durationMs?: number): string {
  if (!durationMs || durationMs <= 0) return '未知'
  return `${Math.max(1, Math.round(durationMs / 1000))} 秒`
}

function isProcessingHistoryStatus(status: ScreenDocHistoryStatus): boolean {
  return status === 'recording' || status === 'finalizing' || status === 'uploading' || status === 'analyzing'
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

  async getHistoryList(): Promise<ScreenDocHistoryRecord[]> {
    return await this.enrichHistorySummaries(this.getHistoryRecords())
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
    let archivedRecordingPath: string | null = null
    let archivedRecordingFileName: string | undefined
    try {
      recordingArtifact = await this.screenRecorder.stopRecording()
      if (this.runId !== currentRunId) return null

      const archivedRecording = await this.archiveRecordingArtifact(recordId, recordingArtifact)
      archivedRecordingPath = archivedRecording.filePath
      archivedRecordingFileName = archivedRecording.fileName
      recordingArtifact = {
        ...recordingArtifact,
        filePath: archivedRecording.filePath
      }
      const archivedStorageBytes = await this.getRecordStorageBytes(recordId)

      await this.updateHistoryRecord(recordId, {
        status: 'finalizing',
        updatedAt: Date.now(),
        durationMs: recordingArtifact.durationMs,
        hasRecordingFile: true,
        recordingFileName: archivedRecording.fileName,
        storageBytes: archivedStorageBytes
      })

      await this.finishAsrTranscript()
      if (this.runId !== currentRunId) return null

      return await this.processArchivedRecording({
        currentRunId,
        recordId,
        recordingArtifact,
        transcript: (this.finalTranscript || this.partialTranscript).trim(),
        createdAt: this.startedAt ?? Date.now(),
        llmApiKey,
        promptTemplate: config.screenDocPrompt,
        baseUrl: config.polishBaseUrl || POLISH_DEFAULT_BASE_URL
      })
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
          title: '录屏整理失败',
          hasRecordingFile: Boolean(archivedRecordingPath),
          recordingFileName: archivedRecordingFileName,
          storageBytes: await this.getRecordStorageBytes(recordId)
        })
        this.setStatus('error', errorMessage)
      }
      return null
    } finally {
      if (recordingArtifact?.filePath && !archivedRecordingPath) {
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
    this.overlay.hideHud()
    if (recordId) {
      await this.persistCancelledRecord(recordId)
    }
    this.partialTranscript = ''
    this.finalTranscript = ''
    this.error = undefined
    this.setStatus('idle')
  }

  destroy(): void {
    void this.cancel()
    this.screenRecorder.destroy()
  }

  async preparePreview(recordId: string): Promise<string | null> {
    const record = await this.getHistoryRecord(recordId)
    if (!record || record.status !== 'ready') {
      throw new Error('该记录还没有可预览的整理结果')
    }

    return await this.writePreviewArtifacts(record, { updateIndex: true })
  }

  async getRecordDirectoryPath(recordId: string): Promise<string> {
    const record = await this.getHistoryRecord(recordId)
    if (!record) {
      throw new Error('未找到对应的录屏整理记录')
    }

    const recordDir = this.getRecordDir(recordId)
    if (!await this.fileExists(recordDir)) {
      throw new Error('该记录的本地归档目录不存在')
    }

    return recordDir
  }

  async exportRecord(recordId?: string): Promise<string | null> {
    const resolvedRecordId = recordId || this.latestResult?.artifactId
    if (!resolvedRecordId) {
      return null
    }

    const record = await this.getHistoryRecord(resolvedRecordId)
    if (!record || record.status !== 'ready') {
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
    const { markdown, html } = await this.buildRecordDocuments(record)
    await this.writeRecordAssets(record, exportDir)
    await mkdir(exportDir, { recursive: true })

    await writeFile(join(exportDir, EXPORT_MARKDOWN_FILE), markdown, 'utf8')
    await writeFile(join(exportDir, EXPORT_HTML_FILE), html, 'utf8')
    return exportDir
  }

  async deleteRecord(recordId: string): Promise<boolean> {
    const records = this.getHistoryRecords()
    const record = records.find((item) => item.id === recordId)
    if (!record) {
      return false
    }
    if (isProcessingHistoryStatus(record.status)) {
      throw new Error('处理中记录暂时不能删除')
    }

    this.saveHistoryRecords(records.filter((item) => item.id !== recordId))
    await this.removePersistedRecord(recordId)

    if (this.latestResult?.artifactId === recordId) {
      this.latestResult = null
    }
    if (this.currentRecordId === recordId) {
      this.currentRecordId = null
    }
    return true
  }

  async reanalyzeRecord(recordId: string): Promise<ScreenDocResultPayload | null> {
    if (this.status !== 'idle' && this.status !== 'ready' && this.status !== 'error') {
      throw new Error('已有录屏整理任务正在进行')
    }

    const config = getConfig(this.configStore)
    const llmApiKey = config.polishApiKey || config.asrApiKey
    if (!llmApiKey) {
      throw new Error('未找到可用的百炼 API Key')
    }

    const record = await this.getHistoryRecord(recordId)
    if (!record || record.status !== 'cancelled') {
      throw new Error('只有已取消的录屏整理才能重新分析')
    }

    const recordingFileName = record.recordingFileName ?? await this.findArchivedRecordingFileName(recordId)
    if (!recordingFileName) {
      throw new Error('该记录缺少原始录屏文件，无法重新分析')
    }

    const recordingFilePath = this.getRecordingFilePath(recordId, recordingFileName)
    if (!await this.fileExists(recordingFilePath)) {
      throw new Error('原始录屏文件不存在，无法重新分析')
    }

    this.runId += 1
    const currentRunId = this.runId
    this.abortController?.abort()
    this.abortController = null
    this.asrClient?.abort()
    this.asrClient = null
    this.partialTranscript = record.transcript ?? ''
    this.finalTranscript = record.transcript ?? ''
    this.error = undefined
    this.latestResult = null
    this.currentRecordId = recordId
    this.startedAt = record.createdAt
    this.setStatus('finalizing')

    await this.updateHistoryRecord(recordId, {
      status: 'finalizing',
      updatedAt: Date.now(),
      title: record.title,
      summary: record.summary,
      stepCount: record.stepCount,
      durationMs: record.durationMs,
      hasRecordingFile: true,
      recordingFileName,
      storageBytes: await this.getRecordStorageBytes(recordId)
    })

    try {
      return await this.processArchivedRecording({
        currentRunId,
        recordId,
        recordingArtifact: {
          filePath: recordingFilePath,
          mimeType: mimeTypeForFilePath(recordingFilePath),
          durationMs: record.durationMs ?? 0
        },
        transcript: (record.transcript ?? '').trim(),
        createdAt: record.createdAt,
        llmApiKey,
        promptTemplate: config.screenDocPrompt,
        baseUrl: config.polishBaseUrl || POLISH_DEFAULT_BASE_URL
      })
    } catch (error) {
      console.error('[ScreenDoc] Failed to reanalyze archived recording:', error)
      if (this.runId === currentRunId) {
        const errorMessage = error instanceof Error ? error.message : '重新分析录屏失败'
        await this.updateHistoryRecord(recordId, {
          status: 'error',
          error: errorMessage,
          updatedAt: Date.now(),
          title: '录屏整理失败',
          durationMs: record.durationMs,
          hasRecordingFile: true,
          recordingFileName,
          storageBytes: await this.getRecordStorageBytes(recordId)
        })
        this.setStatus('error', errorMessage)
      }
      return null
    } finally {
      this.abortController = null
      this.asrClient = null
    }
  }

  private async processArchivedRecording(params: {
    currentRunId: number
    recordId: string
    recordingArtifact: NativeScreenRecordingArtifact
    transcript: string
    createdAt: number
    llmApiKey: string
    promptTemplate: string
    baseUrl: string
  }): Promise<ScreenDocResultPayload | null> {
    const {
      currentRunId,
      recordId,
      recordingArtifact,
      transcript,
      createdAt,
      llmApiKey,
      promptTemplate,
      baseUrl
    } = params

    const recordingFileName = basename(recordingArtifact.filePath)
    const storageBytes = await this.getRecordStorageBytes(recordId)
    let analysis: ScreenDocAnalysis | null = null
    let timelineFrames: ScreenDocFrameInput[] = []
    let frameIntervalMs = 1000

    const canUploadVideo = /^(video\/mp4|video\/quicktime|video\/x-msvideo|video\/x-matroska)$/i.test(recordingArtifact.mimeType)

    if (canUploadVideo) {
      this.setStatus('uploading')
      await this.updateHistoryRecord(recordId, {
        status: 'uploading',
        updatedAt: Date.now(),
        durationMs: recordingArtifact.durationMs,
        hasRecordingFile: true,
        recordingFileName,
        storageBytes
      })
      try {
        const bytes = await readFile(recordingArtifact.filePath)
        const ossUrl = await this.uploadTemporaryFile(
          llmApiKey,
          SCREEN_DOC_MODEL,
          recordingFileName,
          recordingArtifact.mimeType,
          bytes
        )
        if (this.runId !== currentRunId) return null
        this.setStatus('analyzing')
        await this.updateHistoryRecord(recordId, {
          status: 'analyzing',
          updatedAt: Date.now(),
          durationMs: recordingArtifact.durationMs,
          hasRecordingFile: true,
          recordingFileName,
          storageBytes
        })
        analysis = await this.analyzeWithVideo(
          llmApiKey,
          baseUrl,
          ossUrl,
          transcript,
          recordingArtifact.durationMs,
          recordingArtifact.targetDescription,
          promptTemplate
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
        durationMs: recordingArtifact.durationMs,
        hasRecordingFile: true,
        recordingFileName,
        storageBytes
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
        baseUrl,
        timelineFrames,
        frameIntervalMs,
        transcript,
        recordingArtifact.durationMs,
        recordingArtifact.targetDescription,
        promptTemplate
      )
    }

    if (this.runId !== currentRunId) return null

    const screenshots = await this.buildScreenshotsForSteps(
      recordingArtifact.filePath,
      analysis.steps,
      timelineFrames
    )
    const result: ScreenDocResultPayload = {
      artifactId: recordId,
      analysis,
      screenshots,
      markdown: this.buildMarkdown(analysis, screenshots, true),
      createdAt: Date.now()
    }

    this.latestResult = result
    await this.persistHistoryRecord({
      id: recordId,
      createdAt,
      updatedAt: result.createdAt,
      status: 'ready',
      title: analysis.title,
      summary: analysis.summary,
      stepCount: analysis.steps.length,
      durationMs: recordingArtifact.durationMs,
      storageBytes,
      hasRecordingFile: true,
      recordingFileName,
      previewHtmlPath: PREVIEW_HTML_FILE,
      analysis,
      screenshots,
      markdown: result.markdown,
      transcript: analysis.transcript
    })
    this.overlay.hideHud()
    this.setStatus('ready')
    return result
  }

  private async persistCancelledRecord(recordId: string): Promise<void> {
    const existing = await this.getHistoryRecord(recordId)
    const recordingFileName = existing?.recordingFileName ?? await this.findArchivedRecordingFileName(recordId)
    const hasRecordingFile = await this.recordingFileExists(recordId, recordingFileName)
    const transcript = (existing?.transcript ?? this.finalTranscript ?? this.partialTranscript ?? '').trim()
    const cancelledRecord: ScreenDocHistoryRecord = {
      id: recordId,
      createdAt: existing?.createdAt ?? this.startedAt ?? Date.now(),
      updatedAt: Date.now(),
      status: 'cancelled',
      title: '已取消的录屏整理',
      summary: existing?.summary,
      stepCount: existing?.stepCount,
      durationMs: existing?.durationMs,
      storageBytes: await this.getRecordStorageBytes(recordId),
      hasRecordingFile,
      recordingFileName,
      previewHtmlPath: existing?.previewHtmlPath,
      transcript: transcript || undefined
    }

    if (hasRecordingFile || transcript) {
      await this.persistHistoryRecord(cancelledRecord)
      return
    }

    await this.updateHistoryRecord(recordId, {
      status: 'cancelled',
      updatedAt: cancelledRecord.updatedAt,
      title: cancelledRecord.title,
      durationMs: cancelledRecord.durationMs,
      storageBytes: cancelledRecord.storageBytes,
      hasRecordingFile: cancelledRecord.hasRecordingFile,
      recordingFileName: cancelledRecord.recordingFileName
    })
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
    return await this.enrichHistoryRecord(persisted || summary)
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
      storageBytes: updates.storageBytes ?? baseRecord.storageBytes,
      hasRecordingFile: updates.hasRecordingFile ?? baseRecord.hasRecordingFile,
      recordingFileName: updates.recordingFileName ?? baseRecord.recordingFileName,
      previewHtmlPath: updates.previewHtmlPath ?? baseRecord.previewHtmlPath,
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
    await this.updateHistoryRecord(record.id, (await this.loadPersistedRecord(record.id)) ?? record)
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
    return join(this.getRecordDir(recordId), RECORD_FILE)
  }

  private getPreviewHtmlPath(recordId: string): string {
    return join(this.getRecordDir(recordId), PREVIEW_HTML_FILE)
  }

  private getMarkdownPath(recordId: string): string {
    return join(this.getRecordDir(recordId), EXPORT_MARKDOWN_FILE)
  }

  private getRecordingFilePath(recordId: string, fileName: string): string {
    return join(this.getRecordDir(recordId), fileName)
  }

  private async writePersistedRecord(record: ScreenDocHistoryRecord): Promise<void> {
    const recordDir = this.getRecordDir(record.id)
    await mkdir(recordDir, { recursive: true })
    const previewPath = await this.writePreviewArtifacts(record)
    const storageBytes = await this.getRecordStorageBytes(record.id)
    const hasRecordingFile = await this.recordingFileExists(record.id, record.recordingFileName)

    await writeFile(
      this.getRecordFilePath(record.id),
      JSON.stringify(
        {
          ...record,
          markdown: record.markdown ?? await this.readIfExists(this.getMarkdownPath(record.id)),
          previewHtmlPath: previewPath ? PREVIEW_HTML_FILE : record.previewHtmlPath,
          storageBytes,
          hasRecordingFile
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

  private async enrichHistorySummaries(records: ScreenDocHistoryRecord[]): Promise<ScreenDocHistoryRecord[]> {
    const nextRecords = await Promise.all(records.map((record) => this.enrichHistoryRecord(record)))
    const changed = nextRecords.some((record, index) =>
      record.storageBytes !== records[index]?.storageBytes ||
      record.hasRecordingFile !== records[index]?.hasRecordingFile ||
      record.recordingFileName !== records[index]?.recordingFileName ||
      record.previewHtmlPath !== records[index]?.previewHtmlPath
    )

    if (changed) {
      this.saveHistoryRecords(nextRecords)
    }

    return nextRecords
  }

  private async enrichHistoryRecord(record: ScreenDocHistoryRecord): Promise<ScreenDocHistoryRecord> {
    const previewExists = await this.fileExists(this.getPreviewHtmlPath(record.id))
    const recordingFileName = record.recordingFileName ?? await this.findArchivedRecordingFileName(record.id)
    const storageBytes = await this.getRecordStorageBytes(record.id)

    return {
      ...record,
      storageBytes,
      hasRecordingFile: Boolean(recordingFileName),
      recordingFileName: recordingFileName ?? record.recordingFileName,
      previewHtmlPath: previewExists ? PREVIEW_HTML_FILE : record.previewHtmlPath
    }
  }

  private async archiveRecordingArtifact(
    recordId: string,
    artifact: NativeScreenRecordingArtifact
  ): Promise<{ filePath: string; fileName: string }> {
    const recordDir = this.getRecordDir(recordId)
    await mkdir(recordDir, { recursive: true })

    const sourceExt = extname(artifact.filePath)
    const fileExt = sourceExt || extensionForMimeType(artifact.mimeType)
    const fileName = `${RECORDING_FILE_BASENAME}${fileExt}`
    const destination = this.getRecordingFilePath(recordId, fileName)

    if (artifact.filePath !== destination) {
      try {
        await rename(artifact.filePath, destination)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | undefined)?.code
        if (code !== 'EXDEV') {
          throw error
        }
        await copyFile(artifact.filePath, destination)
        await rm(artifact.filePath, { force: true }).catch(() => undefined)
      }
    }

    return { filePath: destination, fileName }
  }

  private async buildRecordDocuments(record: ScreenDocHistoryRecord): Promise<{ markdown: string; html: string }> {
    if (!record.analysis) {
      throw new Error('该记录缺少分析结果，无法生成文档')
    }

    const screenshots = (record.screenshots ?? []).map((screenshot, index) => ({
      ...screenshot,
      relativePath: `assets/step-${String(index + 1).padStart(2, '0')}.png`
    }))
    const markdown = this.buildMarkdown(record.analysis, screenshots, false)
    const html = this.buildHtmlDocument(record, screenshots)
    return { markdown, html }
  }

  private buildHtmlDocument(
    record: ScreenDocHistoryRecord,
    screenshots: Array<ScreenDocScreenshot & { relativePath?: string }>
  ): string {
    if (!record.analysis) {
      throw new Error('该记录缺少分析结果，无法生成 HTML')
    }
    const metaItems = [
      `创建时间：${new Date(record.createdAt).toLocaleString('zh-CN')}`,
      `状态：${this.defaultHistoryTitle(record.status)}`,
      record.stepCount ? `步骤数：${record.stepCount}` : '',
      `录制时长：${formatDurationLabel(record.durationMs)}`,
      record.hasRecordingFile ? '已保存原始录屏' : '无原始录屏文件'
    ].filter(Boolean)
    const notesHtml = record.analysis.notes.length > 0
      ? `<section><h2>补充说明</h2><ul>${record.analysis.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul></section>`
      : ''
    const stepsHtml = record.analysis.steps.map((step, index) => {
      const screenshot = screenshots[index]
      const imageRef = screenshot?.relativePath
      return `<section class="step">
        <div class="step-header">
          <h3>${index + 1}. ${escapeHtml(step.title)}</h3>
          <span class="step-time">${escapeHtml(timestampLabel(step.timestampMs))}</span>
        </div>
        ${imageRef ? `<img src="${escapeHtml(imageRef)}" alt="${escapeHtml(step.title)}" />` : ''}
        <p>${escapeHtml(step.description).replaceAll('\n', '<br />')}</p>
      </section>`
    }).join('')
    const transcriptHtml = record.analysis.transcript.trim()
      ? `<section><h2>语音说明摘录</h2><div class="transcript">${escapeHtml(record.analysis.transcript.trim()).replaceAll('\n', '<br />')}</div></section>`
      : ''

    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(record.title)}</title>
    <style>
      :root { color-scheme: light; }
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f5f7fb; color: #1f2937; }
      main { max-width: 960px; margin: 0 auto; padding: 40px 24px 64px; }
      .hero { background: #fff; border-radius: 20px; padding: 28px; box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08); margin-bottom: 24px; }
      .meta { display: flex; flex-wrap: wrap; gap: 10px 16px; margin-top: 16px; color: #667085; font-size: 14px; }
      article { background: #fff; border-radius: 20px; padding: 28px; box-shadow: 0 16px 40px rgba(15, 23, 42, 0.08); line-height: 1.75; }
      section + section { margin-top: 28px; }
      img { max-width: 100%; border-radius: 14px; border: 1px solid #dbe4f0; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
      h1, h2, h3 { color: #111827; }
      ul { padding-left: 20px; }
      .step { padding-top: 8px; }
      .step-header { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; margin-bottom: 12px; }
      .step-time { color: #667085; font-size: 14px; white-space: nowrap; }
      .transcript { white-space: pre-wrap; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 16px; }
    </style>
  </head>
  <body>
    <main>
      <section class="hero">
        <h1>${escapeHtml(record.title)}</h1>
        ${record.summary ? `<p>${escapeHtml(record.summary)}</p>` : ''}
        <div class="meta">${metaItems.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
      </section>
      <article>
        ${notesHtml}
        <section>
          <h2>操作步骤</h2>
          ${stepsHtml}
        </section>
        ${transcriptHtml}
      </article>
    </main>
  </body>
</html>`
  }

  private async writeRecordAssets(record: ScreenDocHistoryRecord, baseDir?: string): Promise<Array<ScreenDocScreenshot & { relativePath: string }>> {
    const targetDir = baseDir ?? this.getRecordDir(record.id)
    const assetsDir = join(targetDir, 'assets')
    await rm(assetsDir, { recursive: true, force: true }).catch(() => undefined)
    await mkdir(assetsDir, { recursive: true })

    const screenshots = record.screenshots ?? []
    const assetPaths = screenshots.map((screenshot, index) => ({
      ...screenshot,
      relativePath: `assets/step-${String(index + 1).padStart(2, '0')}.png`
    }))

    for (const asset of assetPaths) {
      const parsed = parseDataUrl(asset.dataUrl)
      await writeFile(join(targetDir, asset.relativePath), parsed.buffer)
    }

    return assetPaths
  }

  private async writePreviewArtifacts(
    record: ScreenDocHistoryRecord,
    options: { updateIndex?: boolean } = {}
  ): Promise<string | null> {
    if (record.status !== 'ready' || !record.analysis) {
      return null
    }

    const recordDir = this.getRecordDir(record.id)
    await mkdir(recordDir, { recursive: true })
    const screenshots = await this.writeRecordAssets(record)
    const markdown = this.buildMarkdown(record.analysis, screenshots, false)
    const html = this.buildHtmlDocument(record, screenshots)
    const previewPath = this.getPreviewHtmlPath(record.id)

    await writeFile(this.getMarkdownPath(record.id), markdown, 'utf8')
    await writeFile(previewPath, html, 'utf8')

    if (options.updateIndex) {
      await this.updateHistoryRecord(record.id, {
        status: record.status,
        updatedAt: record.updatedAt,
        title: record.title,
        summary: record.summary,
        stepCount: record.stepCount,
        durationMs: record.durationMs,
        hasRecordingFile: await this.recordingFileExists(record.id, record.recordingFileName),
        recordingFileName: record.recordingFileName ?? await this.findArchivedRecordingFileName(record.id),
        previewHtmlPath: PREVIEW_HTML_FILE,
        storageBytes: await this.getRecordStorageBytes(record.id)
      })
    }

    return previewPath
  }

  private async getRecordStorageBytes(recordId: string): Promise<number> {
    return await this.getPathStorageBytes(this.getRecordDir(recordId))
  }

  private async getPathStorageBytes(targetPath: string): Promise<number> {
    try {
      const targetStat = await stat(targetPath)
      if (!targetStat.isDirectory()) {
        return targetStat.size
      }

      const entries = await readdir(targetPath, { withFileTypes: true })
      let total = 0
      for (const entry of entries) {
        total += await this.getPathStorageBytes(join(targetPath, entry.name))
      }
      return total
    } catch {
      return 0
    }
  }

  private async fileExists(targetPath: string): Promise<boolean> {
    try {
      await stat(targetPath)
      return true
    } catch {
      return false
    }
  }

  private async recordingFileExists(recordId: string, recordingFileName?: string): Promise<boolean> {
    if (!recordingFileName) {
      return Boolean(await this.findArchivedRecordingFileName(recordId))
    }
    return await this.fileExists(this.getRecordingFilePath(recordId, recordingFileName))
  }

  private async findArchivedRecordingFileName(recordId: string): Promise<string | undefined> {
    try {
      const entries = await readdir(this.getRecordDir(recordId))
      return entries.find((entry) => entry.startsWith(`${RECORDING_FILE_BASENAME}.`))
    } catch {
      return undefined
    }
  }

  private async readIfExists(targetPath: string): Promise<string | undefined> {
    try {
      return await readFile(targetPath, 'utf8')
    } catch {
      return undefined
    }
  }

  private async removePersistedRecord(recordId: string): Promise<void> {
    await rm(this.getRecordDir(recordId), { recursive: true, force: true }).catch(() => undefined)
  }
}
