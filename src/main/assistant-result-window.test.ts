// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    on: vi.fn()
  },
  BrowserWindow: vi.fn(),
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1600, height: 900 }
    })),
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
  showAssistantResultWindow
} from './assistant-result-window'

function createWindowStub() {
  let didFinishLoadHandler: (() => void) | null = null
  const send = vi.fn()

  const win = {
    isVisible: vi.fn(() => true),
    webContents: {
      send,
      isLoadingMainFrame: vi.fn(() => true),
      once: vi.fn((event: string, handler: () => void) => {
        if (event === 'did-finish-load') {
          didFinishLoadHandler = handler
        }
      })
    }
  }

  return {
    win,
    send,
    finishLoad: () => {
      didFinishLoadHandler?.()
    }
  }
}

describe('assistant result window payload caching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('caches the latest payload before the renderer finishes loading', () => {
    const { win, send, finishLoad } = createWindowStub()
    const payload = {
      text: '第一次结果',
      reasoningMarkdown: '正在思考'
    }

    showAssistantResultWindow(win as never, payload)

    expect(getLatestAssistantResultPayload(win as never)).toEqual(payload)
    expect(send).not.toHaveBeenCalled()

    finishLoad()

    expect(send).toHaveBeenCalledWith('assistant-result:update', payload)
  })
})
