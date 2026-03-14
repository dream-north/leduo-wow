import { app, BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'
import { applyFloatingWindowBehavior } from './floating-window'

const windowWidth = 520
const windowHeight = 360
let isQuitting = false

app.on('before-quit', () => {
  isQuitting = true
})

export function createAssistantResultWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { x, y, width, height } = display.workArea

  const win = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    x: Math.round(x + (width - windowWidth) / 2),
    y: Math.round(y + (height - windowHeight) / 2),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/assistantResult.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  applyFloatingWindowBehavior(win, 'screen-saver')

  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    hideAssistantResultWindow(win)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/assistant-result.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/assistant-result.html'))
  }

  return win
}

export function positionAssistantResultWindowAtCursor(win: BrowserWindow): void {
  const cursorPoint = screen.getCursorScreenPoint()
  const currentDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const { x, y, width, height } = currentDisplay.workArea
  const targetX = Math.round(x + (width - windowWidth) / 2)
  const targetY = Math.round(y + (height - windowHeight) / 2)
  win.setPosition(targetX, targetY)
}

export function showAssistantResultWindow(win: BrowserWindow, text: string): void {
  positionAssistantResultWindowAtCursor(win)
  applyFloatingWindowBehavior(win, 'screen-saver')

  const showWindow = (): void => {
    win.webContents.send(IPC.ASSISTANT_RESULT_UPDATE, { text })
    win.show()
    win.focus()
    win.moveTop()
  }

  if (win.webContents.isLoadingMainFrame()) {
    win.webContents.once('did-finish-load', showWindow)
    return
  }

  showWindow()
}

export function hideAssistantResultWindow(win: BrowserWindow): void {
  win.webContents.send(IPC.ASSISTANT_RESULT_HIDE)
  win.hide()
}
