import { app, BrowserWindow, clipboard } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'

export function createAssistantResultWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 640,
    height: 520,
    show: false,
    resizable: true,
    title: '语音助手结果',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 12 },
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

  const sendUpdate = (): void => {
    win.webContents.send(IPC.ASSISTANT_RESULT_UPDATE, text)
  }

  win.show()
  win.focus()

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', sendUpdate)
  } else {
    sendUpdate()
  }
}

export function copyAssistantResultText(text: string): void {
  clipboard.writeText(text)
}
