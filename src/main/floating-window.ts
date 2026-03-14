import type { BrowserWindow } from 'electron'

export type FloatingWindowLike = Pick<
  BrowserWindow,
  'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces' | 'moveTop' | 'setHiddenInMissionControl'
>

export function applyFloatingWindowBehavior(
  win: FloatingWindowLike,
  level: 'floating' | 'screen-saver'
): void {
  win.setAlwaysOnTop(true, level, 1)
  win.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  })
  win.setHiddenInMissionControl(true)
  win.moveTop()
}
