// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    on: vi.fn()
  },
  BrowserWindow: vi.fn(),
  screen: {
    getCursorScreenPoint: vi.fn(() => ({ x: 100, y: 100 })),
    getDisplayNearestPoint: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1600, height: 900 }
    })),
    getAllDisplays: vi.fn(() => [{
      workArea: { x: 0, y: 0, width: 1600, height: 900 }
    }])
  },
  shell: {
    openExternal: vi.fn()
  }
}))

vi.mock('@electron-toolkit/utils', () => ({
  is: {
    dev: false
  }
}))

vi.mock('./floating-window', () => ({
  applyFloatingWindowBehavior: vi.fn()
}))

import {
  getLatestAssistantResultPayload,
  hideAssistantResultWindow,
  markAssistantResultWindowReady,
  showAssistantResultWindow
} from './assistant-result-window'

function createWindowStub() {
  const send = vi.fn()
  const setIgnoreMouseEvents = vi.fn()
  const hide = vi.fn()
  const setBounds = vi.fn()
  const setSize = vi.fn()
  const setPosition = vi.fn()
  const getSize = vi.fn(() => [700, 560] as const)
  const showInactive = vi.fn()
  const moveTop = vi.fn()

  const win = {
    isVisible: vi.fn(() => false),
    setIgnoreMouseEvents,
    hide,
    setBounds,
    setSize,
    setPosition,
    getSize,
    showInactive,
    moveTop,
    webContents: {
      send
    }
  }

  return {
    win,
    send,
    setIgnoreMouseEvents,
    hide,
    setBounds,
    showInactive,
    moveTop
  }
}

describe('assistant result window payload caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caches the latest payload until the renderer is ready', () => {
    const { win, send, setIgnoreMouseEvents, showInactive, moveTop } = createWindowStub()
    const payload = {
      text: '第一次结果',
      reasoningMarkdown: '正在思考'
    }

    showAssistantResultWindow(win as never, payload)

    expect(getLatestAssistantResultPayload(win as never)).toEqual(payload)
    expect(send).not.toHaveBeenCalled()

    markAssistantResultWindowReady(win as never)

    expect(send).toHaveBeenCalledWith('assistant-result:update', payload)
    expect(setIgnoreMouseEvents).toHaveBeenCalledWith(false)
    expect(showInactive).toHaveBeenCalled()
    expect(moveTop).toHaveBeenCalled()
  })

  it('makes the window click-through again after hiding', () => {
    const { win, send, setIgnoreMouseEvents, hide, setBounds } = createWindowStub()

    hideAssistantResultWindow(win as never)

    expect(send).not.toHaveBeenCalledWith('assistant-result:hide')
    expect(setIgnoreMouseEvents).toHaveBeenCalledWith(true)
    expect(hide).toHaveBeenCalled()
    expect(setBounds).toHaveBeenCalledWith({
      x: -10000,
      y: -10000,
      width: 1,
      height: 1
    })
  })
})
