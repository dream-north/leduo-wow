// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'
import { applyFloatingWindowBehavior } from './floating-window'

describe('applyFloatingWindowBehavior', () => {
  it('pins floating windows above fullscreen spaces', () => {
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
  })
})
