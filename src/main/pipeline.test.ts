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
  showAssistantResultMock: vi.fn(),
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

vi.mock('./assistant-result-window', () => ({
  showAssistantResultWindow: mockState.showAssistantResultMock
}))

vi.mock('./selected-text', () => ({
  getSelectedText: vi.fn(async () => '')
}))

vi.mock('./macos-apps', () => ({
  getFrontmostApp: vi.fn(async () => null)
}))

vi.mock('./overlay-window', () => ({
  positionOverlayAtCursor: vi.fn()
}))

import { Pipeline } from './pipeline'

function createOverlayWindow() {
  return {
    isDestroyed: () => false,
    hide: vi.fn(),
    showInactive: vi.fn(),
    webContents: {
      send: vi.fn()
    }
  }
}

function createAssistantResultWindow() {
  return {
    isDestroyed: () => false
  }
}

describe('Pipeline assistant output mode', () => {
  beforeEach(() => {
    mockState.config.assistantOutputMode = 'input'
    mockState.addHistoryMock.mockReset()
    mockState.inputMock.mockReset()
    mockState.inputMock.mockResolvedValue(undefined)
    mockState.showAssistantResultMock.mockReset()
    mockState.broadcastSendMock.mockReset()
    vi.useFakeTimers()
  })

  it('inputs assistant output into the frontmost app when output mode is input', async () => {
    const overlayWindow = createOverlayWindow()
    const assistantResultWindow = createAssistantResultWindow()
    const pipeline = new Pipeline(overlayWindow as never, assistantResultWindow as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('生成结果')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(mockState.inputMock).toHaveBeenCalledWith('生成结果', 'clipboard')
    expect(mockState.showAssistantResultMock).not.toHaveBeenCalled()
    expect(mockState.addHistoryMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        originalText: '生成结果',
        polishedText: '生成结果',
        mode: 'assistant'
      })
    )
    expect(mockState.broadcastSendMock).toHaveBeenCalledWith(IPC.PIPELINE_FINAL_TEXT, '生成结果', 'assistant')
    expect(overlayWindow.hide).toHaveBeenCalled()
  })

  it('shows assistant output in the dedicated window when output mode is window', async () => {
    mockState.config.assistantOutputMode = 'window'

    const overlayWindow = createOverlayWindow()
    const assistantResultWindow = createAssistantResultWindow()
    const pipeline = new Pipeline(overlayWindow as never, assistantResultWindow as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('弹窗结果')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(mockState.inputMock).not.toHaveBeenCalled()
    expect(mockState.showAssistantResultMock).toHaveBeenCalledWith(assistantResultWindow, '弹窗结果')
    expect(mockState.addHistoryMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        originalText: '弹窗结果',
        polishedText: '弹窗结果',
        mode: 'assistant'
      })
    )
    expect(mockState.broadcastSendMock).toHaveBeenCalledWith(IPC.PIPELINE_FINAL_TEXT, '弹窗结果', 'assistant')
    expect(overlayWindow.hide).toHaveBeenCalled()
  })
})
