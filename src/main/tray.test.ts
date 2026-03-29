// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PipelineStatus } from '../shared/types'

const electronMocks = vi.hoisted(() => {
  const trayInstance = {
    setToolTip: vi.fn(),
    on: vi.fn(),
    popUpContextMenu: vi.fn(),
    destroy: vi.fn()
  }

  const image = {
    isEmpty: vi.fn(() => false),
    resize: vi.fn(() => image),
    setTemplateImage: vi.fn()
  }

  return {
    trayInstance,
    buildFromTemplate: vi.fn((template) => ({ template })),
    createFromPath: vi.fn(() => image),
    createEmpty: vi.fn(() => image),
    quit: vi.fn()
  }
})

vi.mock('electron', () => ({
  Tray: function MockTray() {
    return electronMocks.trayInstance
  },
  Menu: {
    buildFromTemplate: electronMocks.buildFromTemplate
  },
  nativeImage: {
    createFromPath: electronMocks.createFromPath,
    createEmpty: electronMocks.createEmpty
  },
  app: {
    isPackaged: false,
    quit: electronMocks.quit
  }
}))

import { createTray, destroyTray, updateTrayMenu } from './tray'

describe('tray screen doc actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    destroyTray()
  })

  it('shows stop and cancel actions while screen doc recording is active', () => {
    const stopScreenDoc = vi.fn()
    const cancelScreenDoc = vi.fn()

    createTray({
      showSettings: vi.fn(),
      checkForUpdate: vi.fn(),
      getStatus: () => PipelineStatus.IDLE,
      getScreenDocStatus: () => 'recording',
      stopScreenDoc,
      cancelScreenDoc
    })

    updateTrayMenu()

    const template = electronMocks.buildFromTemplate.mock.calls.at(-1)?.[0] as Array<{
      label?: string
      click?: () => void
    }>

    expect(template.map((item) => item.label).filter(Boolean)).toContain('状态: 录屏整理中...')
    expect(template.map((item) => item.label).filter(Boolean)).toContain('停止录屏整理')
    expect(template.map((item) => item.label).filter(Boolean)).toContain('取消本次录屏')

    template.find((item) => item.label === '停止录屏整理')?.click?.()
    template.find((item) => item.label === '取消本次录屏')?.click?.()

    expect(stopScreenDoc).toHaveBeenCalledOnce()
    expect(cancelScreenDoc).toHaveBeenCalledOnce()
  })
})
