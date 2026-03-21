import type { BrowserWindow } from 'electron'

export type FloatingWindowLike = Pick<
  BrowserWindow,
  'setAlwaysOnTop' | 'setVisibleOnAllWorkspaces' | 'moveTop' | 'setHiddenInMissionControl'
>

interface FloatingWindowBehaviorOptions {
  windowsLevel?: 'floating' | 'screen-saver' | 'pop-up-menu'
}

export function applyFloatingWindowBehavior(
  win: FloatingWindowLike,
  level: 'floating' | 'screen-saver',
  options?: FloatingWindowBehaviorOptions
): void {
  const isMac = process.platform === 'darwin'
  const topLevel = isMac ? level : (options?.windowsLevel ?? 'pop-up-menu')
  win.setAlwaysOnTop(true, topLevel, 1)
  if (isMac) {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true
    })
    win.setHiddenInMissionControl(true)
  }
  win.moveTop()
}
