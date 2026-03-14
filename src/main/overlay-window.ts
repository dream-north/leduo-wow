import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { applyFloatingWindowBehavior } from './floating-window'

const winWidth = 400
const winHeight = 120
const hiddenWindowBounds = {
  x: -10000,
  y: -10000,
  width: 1,
  height: 1
}

export function createOverlayWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: hiddenWindowBounds.width,
    height: hiddenWindowBounds.height,
    x: hiddenWindowBounds.x,
    y: hiddenWindowBounds.y,
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    focusable: false,
    fullscreenable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/overlay.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  applyFloatingWindowBehavior(win, 'screen-saver')
  win.setIgnoreMouseEvents(true)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  return win
}

/**
 * 将窗口定位到光标所在的屏幕底部中央
 */
export function positionOverlayAtCursor(win: BrowserWindow): void {
  // 获取光标所在的屏幕
  const cursorPoint = screen.getCursorScreenPoint()
  const currentDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { width: screenWidth, height: screenHeight } = currentDisplay.workAreaSize

  // 计算新位置：屏幕底部中央
  const x = currentDisplay.bounds.x + Math.round((screenWidth - winWidth) / 2)
  const y = currentDisplay.bounds.y + screenHeight - winHeight - 80

  win.setBounds({ x, y, width: winWidth, height: winHeight })
}

export function parkOverlayWindow(win: BrowserWindow): void {
  win.setBounds(hiddenWindowBounds)
}
