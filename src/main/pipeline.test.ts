// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc-channels'

const mockState = vi.hoisted(() => ({
  config: {
    asrApiKey: 'asr-key',
    asrModel: 'qwen3-asr-flash-realtime',
    asrBaseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
    polishEnabled: false,
    polishApiKey: '',
    polishModel: 'qwen3.5-flash',
    polishBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    polishPrompt: '',
    assistantEnabled: true,
    assistantPrePolish: false,
    assistantOutputMode: 'input' as 'input' | 'window',
    assistantModel: 'qwen3.5-flash',
    assistantPrompt: '',
    screenshotEnabled: false,
    screenshotSavePath: '',
    screenshotMaxCount: 30,
    screenshotExcludedApps: [],
    audioThreshold: 0,
    selectedMicrophoneId: '',
    inputMethod: 'clipboard' as 'clipboard' | 'applescript'
  },
  addHistoryMock: vi.fn(),
  inputMock: vi.fn(),
  broadcastSendMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: mockState.broadcastSendMock
        }
      }
    ]
  },
  desktopCapturer: {
    getSources: vi.fn(async () => [])
  },
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getDisplayNearestPoint: vi.fn(() => ({
      id: 1,
      size: { width: 1440, height: 900 }
    }))
  }
}))

vi.mock('./config-store', () => ({
  getConfig: () => mockState.config,
  addHistory: mockState.addHistoryMock
}))

vi.mock('./text-inputter', () => ({
  TextInputter: vi.fn(function MockTextInputter(this: { input: typeof mockState.inputMock }) {
    this.input = mockState.inputMock
  })
}))

vi.mock('./selected-text', () => ({
  getSelectedText: vi.fn(async () => '')
}))

vi.mock('./macos-apps', () => ({
  getFrontmostApp: vi.fn(async () => null)
}))

vi.mock('./asr-client', () => ({
  ASRClient: vi.fn(function MockASRClient(this: Record<string, unknown>) {
    this.on = vi.fn()
    this.once = vi.fn()
    this.start = vi.fn(async () => {})
    this.appendAudio = vi.fn()
    this.finish = vi.fn(async () => {})
    this.abort = vi.fn()
  })
}))

import { Pipeline } from './pipeline'

function createOverlayBackend() {
  return {
    id: 'test-overlay',
    start: vi.fn(() => true),
    destroy: vi.fn(),
    isAvailable: vi.fn(() => true),
    showHud: vi.fn(),
    updateHud: vi.fn(),
    hideHud: vi.fn(),
    showResult: vi.fn(),
    hideResult: vi.fn(),
    dismissAll: vi.fn()
  }
}

describe('Pipeline assistant output mode', () => {
  beforeEach(() => {
    mockState.config.assistantOutputMode = 'input'
    mockState.addHistoryMock.mockReset()
    mockState.inputMock.mockReset()
    mockState.inputMock.mockResolvedValue(undefined)
    mockState.broadcastSendMock.mockReset()
    vi.useFakeTimers()
  })

  it('inputs assistant output into the frontmost app when output mode is input', async () => {
    const overlay = createOverlayBackend()
    const pipeline = new Pipeline(overlay as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('生成结果')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(mockState.inputMock).toHaveBeenCalledWith('生成结果', 'clipboard')
    expect(overlay.showResult).not.toHaveBeenCalled()
    expect(overlay.hideHud).toHaveBeenCalled()
    expect(mockState.addHistoryMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        originalText: '生成结果',
        polishedText: '生成结果',
        mode: 'assistant'
      })
    )
    expect(mockState.broadcastSendMock).toHaveBeenCalledWith(IPC.PIPELINE_FINAL_TEXT, '生成结果', 'assistant')
  })

  it('shows assistant output in the dedicated overlay window when output mode is window', async () => {
    mockState.config.assistantOutputMode = 'window'

    const overlay = createOverlayBackend()
    const pipeline = new Pipeline(overlay as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('弹窗结果')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(mockState.inputMock).not.toHaveBeenCalled()
    expect(overlay.showResult).toHaveBeenCalledWith({
      text: '弹窗结果',
      format: 'markdown'
    })
    expect(mockState.addHistoryMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        originalText: '弹窗结果',
        polishedText: '弹窗结果',
        mode: 'assistant'
      })
    )
    expect(mockState.broadcastSendMock).toHaveBeenCalledWith(IPC.PIPELINE_FINAL_TEXT, '弹窗结果', 'assistant')
  })

  it('hides previous result windows before starting a new recording', async () => {
    const overlay = createOverlayBackend()
    const pipeline = new Pipeline(overlay as never, {} as never)

    await pipeline.toggle('assistant')

    expect(overlay.hideResult).toHaveBeenCalledTimes(1)
    expect(overlay.updateHud).toHaveBeenCalledWith({
      text: '正在聆听...',
      mode: 'recording',
      voiceMode: 'assistant',
      screenshotActive: false
    })
  })
})
