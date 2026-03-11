import { app, BrowserWindow, clipboard, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'

let latestAssistantResultText = ''

export function createAssistantResultWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 520,
    show: false,
    resizable: true,
    title: '语音助手结果',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#F3F5F9',
    webPreferences: {
      preload: join(__dirname, '../preload/assistant-result.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/assistant-result.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/assistant-result.html'))
  }

  // Don't destroy the window when users close it, so it can be shown again quickly.
  win.on('close', (event) => {
    const appWithQuittingFlag = app as Electron.App & { isQuitting?: boolean }
    if (appWithQuittingFlag.isQuitting) return
    event.preventDefault()
    win.hide()
  })

  return win
}

export function showAssistantResultWindow(win: BrowserWindow | null, text: string): void {
  if (!win || win.isDestroyed()) return
  latestAssistantResultText = text

  const cursorPoint = screen.getCursorScreenPoint()
  const targetDisplay = screen.getDisplayNearestPoint(cursorPoint)
  const [winWidth, winHeight] = win.getSize()
  const x = targetDisplay.bounds.x + Math.round((targetDisplay.bounds.width - winWidth) / 2)
  const y = targetDisplay.bounds.y + Math.round((targetDisplay.bounds.height - winHeight) / 2)
  win.setPosition(x, y)

  const sendUpdate = (): void => {
    win.webContents.send(IPC.ASSISTANT_RESULT_UPDATE, latestAssistantResultText)
  }

  win.show()
  win.focus()

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', sendUpdate)
  } else {
    sendUpdate()
    setTimeout(sendUpdate, 120)
  }
}

export function getLatestAssistantResultText(): string {
  return latestAssistantResultText
}

export function copyAssistantResultText(text: string): void {
  clipboard.writeText(text)
}
