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
    assistantEnableThinking: false,
    assistantEnableSearch: false,
    assistantEnableCodeInterpreter: false,
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

const llmPolisherState = vi.hoisted(() => ({
  polishStreamMock: vi.fn(async (text: string) => text),
  polishStreamWithMetadataMock: vi.fn(async (text: string): Promise<any> => ({ text })),
  respondWithToolsMock: vi.fn(async (text: string): Promise<any> => ({ text }))
}))

vi.mock('./llm-polisher', () => ({
  LLMPolisher: vi.fn(function MockLLMPolisher(this: {
    polishStream: typeof llmPolisherState.polishStreamMock
    polishStreamWithMetadata: typeof llmPolisherState.polishStreamWithMetadataMock
    respondWithTools: typeof llmPolisherState.respondWithToolsMock
  }) {
    this.polishStream = llmPolisherState.polishStreamMock
    this.polishStreamWithMetadata = llmPolisherState.polishStreamWithMetadataMock
    this.respondWithTools = llmPolisherState.respondWithToolsMock
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
    mockState.config.polishApiKey = ''
    mockState.config.assistantEnableThinking = false
    mockState.config.assistantEnableSearch = false
    mockState.config.assistantEnableCodeInterpreter = false
    mockState.addHistoryMock.mockReset()
    mockState.inputMock.mockReset()
    mockState.inputMock.mockResolvedValue(undefined)
    mockState.broadcastSendMock.mockReset()
    llmPolisherState.polishStreamMock.mockReset()
    llmPolisherState.polishStreamMock.mockImplementation(async (text: string) => text)
    llmPolisherState.polishStreamWithMetadataMock.mockReset()
    llmPolisherState.polishStreamWithMetadataMock.mockImplementation(async (text: string) => ({ text }))
    llmPolisherState.respondWithToolsMock.mockReset()
    llmPolisherState.respondWithToolsMock.mockImplementation(async (text: string) => ({ text }))
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

  it('passes assistant-only thinking and search flags to the assistant model call', async () => {
    mockState.config.polishApiKey = 'llm-key'
    mockState.config.assistantEnableThinking = true
    mockState.config.assistantEnableSearch = true

    const overlay = createOverlayBackend()
    const pipeline = new Pipeline(overlay as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('帮我总结')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(llmPolisherState.polishStreamWithMetadataMock).toHaveBeenCalledWith(
      '帮我总结',
      '',
      undefined,
      expect.any(Function),
      {
        enableThinking: true,
        enableSearch: true
      }
    )
  })

  it('includes streamed reasoning content in assistant details when thinking is enabled', async () => {
    mockState.config.assistantOutputMode = 'window'
    mockState.config.polishApiKey = 'llm-key'
    mockState.config.assistantEnableThinking = true
    llmPolisherState.polishStreamWithMetadataMock.mockResolvedValue({
      text: '这是最终回答',
      usage: {
        totalTokens: 200,
        reasoningTokens: 88,
        reasoningContent: '先分析问题，再给出结论。'
      }
    })

    const overlay = createOverlayBackend()
    const pipeline = new Pipeline(overlay as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('帮我想一想')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(overlay.showResult).toHaveBeenCalledWith({
      text: '这是最终回答',
      format: 'markdown',
      detailsMarkdown: expect.stringContaining('思考过程'),
      stats: expect.arrayContaining([
        expect.objectContaining({
          kind: 'tokens-thinking',
          detail: expect.stringContaining('先分析问题，再给出结论。')
        })
      ])
    })
  })

  it('uses the responses tool path when Python interpreter is enabled and shows usage details in the result payload', async () => {
    mockState.config.assistantOutputMode = 'window'
    mockState.config.polishApiKey = 'llm-key'
    mockState.config.assistantEnableThinking = true
    mockState.config.assistantEnableSearch = true
    mockState.config.assistantEnableCodeInterpreter = true
    llmPolisherState.respondWithToolsMock.mockResolvedValue({
      text: '计算结果是 1728',
      usage: {
        totalTokens: 321,
        inputTokens: 120,
        outputTokens: 201,
        tools: {
          codeInterpreterCount: 1,
          webSearchCount: 2,
          webExtractorCount: 1
        }
      }
    })

    const overlay = createOverlayBackend()
    const pipeline = new Pipeline(overlay as never, {} as never)

    ;(pipeline as any).currentMode = 'assistant'
    const task = (pipeline as any).onASRComplete('请计算 12 的三次方')
    await vi.advanceTimersByTimeAsync(100)
    await task

    expect(llmPolisherState.respondWithToolsMock).toHaveBeenCalledWith(
      '请计算 12 的三次方',
      '',
      undefined,
      {
        enableThinking: true,
        enableSearch: true,
        enableCodeInterpreter: true
      }
    )
    expect(overlay.showResult).toHaveBeenCalledWith({
      text: '计算结果是 1728',
      format: 'markdown',
      detailsMarkdown: expect.stringContaining('代码解释器调用次数：1'),
      stats: expect.arrayContaining([
        expect.objectContaining({
          kind: 'code-interpreter',
          value: '1'
        })
      ])
    })
  })
})
