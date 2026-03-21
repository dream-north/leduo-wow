// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { applyFloatingWindowBehavior } from './floating-window'

describe('applyFloatingWindowBehavior', () => {
  it('uses macOS fullscreen workspace behavior on darwin', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })

    const win = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      setHiddenInMissionControl: vi.fn(),
      moveTop: vi.fn()
    }

    applyFloatingWindowBehavior(win as never, 'screen-saver')

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver', 1)
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    expect(win.setHiddenInMissionControl).toHaveBeenCalledWith(true)
    expect(win.moveTop).toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('uses Windows-safe always-on-top behavior off macOS', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const win = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      setHiddenInMissionControl: vi.fn(),
      moveTop: vi.fn()
    }

    applyFloatingWindowBehavior(win as never, 'screen-saver')

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'pop-up-menu', 1)
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled()
    expect(win.setHiddenInMissionControl).not.toHaveBeenCalled()
    expect(win.moveTop).toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })

  it('can opt into the higher screen-saver level on Windows for passive HUD windows', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const win = {
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      setHiddenInMissionControl: vi.fn(),
      moveTop: vi.fn()
    }

    applyFloatingWindowBehavior(win as never, 'screen-saver', {
      windowsLevel: 'screen-saver'
    })

    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver', 1)
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled()
    expect(win.setHiddenInMissionControl).not.toHaveBeenCalled()
    expect(win.moveTop).toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: originalPlatform })
  })
})
