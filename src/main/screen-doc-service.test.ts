// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScreenDocHistoryRecord } from '../shared/types'
import { DEFAULT_CONFIG } from '../shared/types'

const electronMocks = vi.hoisted(() => ({
  getAllWindows: vi.fn(() => []),
  showOpenDialog: vi.fn(),
  getPath: vi.fn(() => tmpdir())
}))

const asrMocks = vi.hoisted(() => ({
  instances: [] as Array<{
    appendAudio: ReturnType<typeof vi.fn>
    start: ReturnType<typeof vi.fn>
    finish: ReturnType<typeof vi.fn>
    abort: ReturnType<typeof vi.fn>
  }>
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: electronMocks.getAllWindows
  },
  app: {
    getPath: electronMocks.getPath
  },
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog
  }
}))

vi.mock('./asr-client', async () => {
  const { EventEmitter } = await import('events')

  return {
    ASRClient: class MockASRClient extends EventEmitter {
      readonly appendAudio = vi.fn()
      readonly start = vi.fn(async () => {})
      readonly finish = vi.fn(async () => {
        this.emit('completed', '先打开页面，再点击确认按钮')
      })
      readonly abort = vi.fn()

      constructor(..._args: unknown[]) {
        super()
        asrMocks.instances.push(this)
      }
    }
  }
})

import { ScreenDocService } from './screen-doc-service'

function createConfigStore(overrides: Partial<typeof DEFAULT_CONFIG> = {}) {
  const values: Record<string, unknown> = {
    ...DEFAULT_CONFIG,
    asrApiKey: 'sk-asr',
    polishApiKey: 'sk-polish',
    ...overrides
  }

  return {
    get: (key: string) => values[key],
    set: (key: string, value: unknown) => {
      values[key] = value
    }
  }
}

function createOverlayStub() {
  return {
    hideResult: vi.fn(),
    hideHud: vi.fn(),
    updateHud: vi.fn()
  }
}

function createScreenRecorderStub(overrides: Partial<{
  startRecording: () => Promise<{ filePath: string; targetDescription?: string }>
  stopRecording: () => Promise<{ filePath: string; mimeType: string; durationMs: number; targetDescription?: string }>
  cancelRecording: () => Promise<void>
  extractScreenshots: (_filePath: string, _timestampsMs: number[]) => Promise<Array<{ timestampMs: number; dataUrl: string }>>
  extractTimelineFrames: (_filePath: string, _intervalMs: number, _maxFrames: number) => Promise<{
    frames: Array<{ timestampMs: number; dataUrl: string }>
    intervalMs: number
  }>
}> = {}) {
  const stub = {
    startRecording: vi.fn(overrides.startRecording || (async () => ({
      filePath: '/tmp/screen-doc.mp4',
      targetDescription: '显示器 1440x900'
    }))),
    stopRecording: vi.fn(overrides.stopRecording || (async () => ({
      filePath: '/tmp/screen-doc.mp4',
      mimeType: 'video/mp4',
      durationMs: 4000,
      targetDescription: '显示器 1440x900'
    }))),
    cancelRecording: vi.fn(overrides.cancelRecording || (async () => {})),
    extractScreenshots: vi.fn(overrides.extractScreenshots || (async (_filePath: string, timestampsMs: number[]) => (
      timestampsMs.map((timestampMs, index) => ({
        timestampMs,
        dataUrl: makePngDataUrl(String(index + 1))
      }))
    ))),
    extractTimelineFrames: vi.fn(overrides.extractTimelineFrames || (async () => ({
      frames: [
        { timestampMs: 1000, dataUrl: makePngDataUrl('a') },
        { timestampMs: 2000, dataUrl: makePngDataUrl('b') },
        { timestampMs: 3000, dataUrl: makePngDataUrl('c') }
      ],
      intervalMs: 1000
    }))),
    on: vi.fn(function () { return stub })
  }

  return stub
}

function makePngDataUrl(seed: string): string {
  return `data:image/png;base64,${Buffer.from(`png-${seed}`).toString('base64')}`
}

describe('ScreenDocService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    asrMocks.instances.length = 0
    electronMocks.getAllWindows.mockReturnValue([])
    electronMocks.showOpenDialog.mockReset()
    electronMocks.getPath.mockReturnValue(tmpdir())
  })

  it('uploads mp4 recordings to DashScope temporary storage and analyzes them as video', async () => {
    const overlay = createOverlayStub()
    const tmpDir = await mkdtemp(join(tmpdir(), 'screen-doc-recording-'))
    electronMocks.getPath.mockReturnValue(tmpDir)
    const recordingPath = join(tmpDir, 'demo.mp4')
    await writeFile(recordingPath, 'fake-mp4')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            upload_dir: 'tmp/uploads',
            oss_access_key_id: 'ak',
            signature: 'sig',
            policy: 'policy',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
            upload_host: 'https://upload.example.com'
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                title: '录屏整理标题',
                summary: '这是摘要',
                notes: ['注意先完成登录'],
                steps: [
                  {
                    title: '打开页面',
                    description: '用户打开页面并准备操作。',
                    timestampMs: 1000,
                    screenshotTimestampMs: 1200
                  }
                ]
              })
            }
          }]
        })
      })

    vi.stubGlobal('fetch', fetchMock)
    const screenRecorder = createScreenRecorderStub({
      startRecording: async () => ({ filePath: recordingPath, targetDescription: '显示器 1440x900' }),
      stopRecording: async () => ({
        filePath: recordingPath,
        mimeType: 'video/mp4',
        durationMs: 4000,
        targetDescription: '显示器 1440x900'
      }),
      extractScreenshots: async (filePath: string, timestampsMs: number[]) => {
        expect(filePath).toContain(join('screen-doc-history', 'artifacts'))
        return timestampsMs.map((timestampMs, index) => ({
          timestampMs,
          dataUrl: makePngDataUrl(`shot-${index + 1}`)
        }))
      }
    })

    const service = new ScreenDocService({
      overlay: overlay as never,
      configStore: createConfigStore() as never,
      screenRecorder: screenRecorder as never
    })

    await expect(service.start()).resolves.toEqual({ ok: true })

    const result = await service.stop()

    expect(result?.analysis.title).toBe('录屏整理标题')
    expect(result?.analysis.steps).toHaveLength(1)
    expect(service.getStatus()).toBe('ready')
    expect(screenRecorder.startRecording).toHaveBeenCalledOnce()
    expect(screenRecorder.stopRecording).toHaveBeenCalledOnce()
    expect(screenRecorder.extractTimelineFrames).not.toHaveBeenCalled()
    const savedRecord = await service.getHistoryRecord(result!.artifactId)
    expect(savedRecord?.status).toBe('ready')
    expect(savedRecord?.analysis?.title).toBe('录屏整理标题')
    expect(savedRecord?.hasRecordingFile).toBe(true)
    expect(savedRecord?.recordingFileName).toBe('recording.mp4')
    expect(savedRecord?.storageBytes).toBeGreaterThan(0)
    expect(savedRecord?.previewHtmlPath).toBe('preview.html')
    const persistedRecord = JSON.parse(
      await readFile(join(tmpDir, 'screen-doc-history', 'artifacts', result!.artifactId, 'record.json'), 'utf8')
    )
    expect(persistedRecord.title).toBe('录屏整理标题')
    await expect(readFile(join(tmpDir, 'screen-doc-history', 'artifacts', result!.artifactId, 'recording.mp4'), 'utf8'))
      .resolves.toBe('fake-mp4')
    await expect(readFile(join(tmpDir, 'screen-doc-history', 'artifacts', result!.artifactId, 'preview.html'), 'utf8'))
      .resolves.toContain('<!doctype html>')

    expect(fetchMock).toHaveBeenCalledTimes(3)
    const analyzeCall = fetchMock.mock.calls[2]
    const analyzeInit = analyzeCall[1] as RequestInit
    const analyzeHeaders = analyzeInit.headers as Record<string, string>
    const analyzeBody = JSON.parse(String(analyzeInit.body))

    expect(analyzeHeaders['X-DashScope-OssResourceResolve']).toBe('enable')
    expect(analyzeBody.messages[1].content[0]).toEqual(
      expect.objectContaining({
        type: 'video_url',
        video_url: { url: 'oss://tmp/uploads/recording.mp4' }
      })
    )
  })

  it('falls back to frame analysis and exports markdown and html with relative asset paths', async () => {
    const overlay = createOverlayStub()
    const tmpDir = await mkdtemp(join(tmpdir(), 'screen-doc-history-'))
    electronMocks.getPath.mockReturnValue(tmpDir)
    const recordingPath = join(tmpDir, 'demo.webm')
    await writeFile(recordingPath, 'fake-webm')
    const screenRecorder = createScreenRecorderStub({
      stopRecording: async () => ({
        filePath: recordingPath,
        mimeType: 'video/webm',
        durationMs: 5000,
        targetDescription: '窗口 1200x800'
      }),
      extractScreenshots: async (_filePath: string, timestampsMs: number[]) => (
        timestampsMs.map((timestampMs) => ({
          timestampMs,
          dataUrl: makePngDataUrl('step')
        }))
      )
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              title: '关键帧整理',
              summary: '通过关键帧完成整理。',
              notes: [],
              steps: [
                {
                  title: '点击确认',
                  description: '用户点击确认按钮，完成提交。',
                  timestampMs: 2100,
                  screenshotTimestampMs: 2000
                }
              ]
            })
          }
        }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const exportBaseDir = await mkdtemp(join(tmpdir(), 'screen-doc-export-'))
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: [exportBaseDir]
    })

    const service = new ScreenDocService({
      overlay: overlay as never,
      configStore: createConfigStore() as never,
      screenRecorder: screenRecorder as never
    })

    await service.start()
    const result = await service.stop()

    expect(result?.analysis.title).toBe('关键帧整理')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(screenRecorder.extractTimelineFrames).toHaveBeenCalledOnce()

    const exportDir = await service.exportRecord(result?.artifactId)
    expect(exportDir).toBeTruthy()

    const assets = await readdir(join(exportDir!, 'assets'))
    const markdown = await readFile(join(exportDir!, 'doc.md'), 'utf8')
    const html = await readFile(join(exportDir!, 'doc.html'), 'utf8')

    expect(assets).toEqual(['step-01.png'])
    expect(markdown).toContain('![点击确认](assets/step-01.png)')
    expect(markdown).toContain('## 语音说明摘录')
    expect(html).toContain('点击确认')
    expect(html).toContain('<!doctype html>')

    const analyzeBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(analyzeBody.messages[1].content[0].type).toBe('video')
  })

  it('repairs mildly malformed JSON from video analysis instead of falling back to frames', async () => {
    const overlay = createOverlayStub()
    const tmpDir = await mkdtemp(join(tmpdir(), 'screen-doc-repair-'))
    electronMocks.getPath.mockReturnValue(tmpDir)
    const recordingPath = join(tmpDir, 'repair.mp4')
    await writeFile(recordingPath, 'fake-mp4')

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            upload_dir: 'tmp/uploads',
            oss_access_key_id: 'ak',
            signature: 'sig',
            policy: 'policy',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
            upload_host: 'https://upload.example.com'
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => ''
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: `{
                "title": "修复后的录屏整理",
                "summary": "模型返回了轻微坏掉的 JSON。",
                "notes": [],
                "steps": [
                  {
                    "title": "点击保存",
                    "description": "用户点击"保存"按钮并确认提交。",
                    "timestampMs": 1800,
                    "screenshotTimestampMs": 2000,
                  }
                ]
              }`
            }
          }]
        })
      })

    vi.stubGlobal('fetch', fetchMock)

    const screenRecorder = createScreenRecorderStub({
      startRecording: async () => ({ filePath: recordingPath, targetDescription: '窗口 1440x900' }),
      stopRecording: async () => ({
        filePath: recordingPath,
        mimeType: 'video/mp4',
        durationMs: 5000,
        targetDescription: '窗口 1440x900'
      })
    })

    const service = new ScreenDocService({
      overlay: overlay as never,
      configStore: createConfigStore() as never,
      screenRecorder: screenRecorder as never
    })

    await expect(service.start()).resolves.toEqual({ ok: true })
    const result = await service.stop()

    expect(result?.analysis.title).toBe('修复后的录屏整理')
    expect(result?.analysis.steps[0]?.description).toContain('点击"保存"按钮')
    expect(screenRecorder.extractTimelineFrames).not.toHaveBeenCalled()
  })

  it('cancels the native recording and resets status back to idle', async () => {
    const overlay = createOverlayStub()
    const tmpDir = await mkdtemp(join(tmpdir(), 'screen-doc-cancel-'))
    electronMocks.getPath.mockReturnValue(tmpDir)
    const screenRecorder = createScreenRecorderStub()
    const service = new ScreenDocService({
      overlay: overlay as never,
      configStore: createConfigStore() as never,
      screenRecorder: screenRecorder as never
    })

    await service.start()
    await service.cancel()

    expect(screenRecorder.cancelRecording).toHaveBeenCalledOnce()
    expect(service.getStatus()).toBe('idle')
    expect(overlay.hideHud).toHaveBeenCalled()
    expect((await service.getHistoryList())[0]?.status).toBe('cancelled')
  })

  it('backfills storage size for older records and deletes archived files', async () => {
    const overlay = createOverlayStub()
    const tmpDir = await mkdtemp(join(tmpdir(), 'screen-doc-backfill-'))
    electronMocks.getPath.mockReturnValue(tmpDir)
    const recordId = 'legacy-record'
    const recordDir = join(tmpDir, 'screen-doc-history', 'artifacts', recordId)
    await mkdir(recordDir, { recursive: true })
    await writeFile(join(recordDir, 'doc.md'), '# 历史结果\n')
    await writeFile(join(recordDir, 'preview.html'), '<!doctype html><title>历史结果</title>')
    await writeFile(join(recordDir, 'recording.mp4'), 'legacy-video')
    await writeFile(
      join(recordDir, 'record.json'),
      JSON.stringify({
        id: recordId,
        createdAt: 1,
        updatedAt: 2,
        status: 'ready',
        title: '历史结果',
        summary: '旧记录',
        stepCount: 1,
        durationMs: 3000,
        analysis: {
          title: '历史结果',
          summary: '旧记录',
          notes: [],
          transcript: '',
          steps: [{
            title: '步骤 1',
            description: '说明',
            timestampMs: 1000,
            screenshotTimestampMs: 1000
          }]
        },
        screenshots: []
      }),
      'utf8'
    )

    const service = new ScreenDocService({
      overlay: overlay as never,
      configStore: createConfigStore() as never,
      screenRecorder: createScreenRecorderStub() as never
    })

    ;(service as unknown as { historyFallback: ScreenDocHistoryRecord[] }).historyFallback = [{
      id: recordId,
      createdAt: 1,
      updatedAt: 2,
      status: 'ready',
      title: '历史结果',
      summary: '旧记录',
      stepCount: 1,
      durationMs: 3000
    }]

    const history = await service.getHistoryList()
    expect(history[0]?.storageBytes).toBeGreaterThan(0)
    expect(history[0]?.hasRecordingFile).toBe(true)
    expect(history[0]?.recordingFileName).toBe('recording.mp4')

    await expect(service.deleteRecord(recordId)).resolves.toBe(true)
    await expect(readFile(join(recordDir, 'recording.mp4'), 'utf8')).rejects.toBeTruthy()
  })
})
