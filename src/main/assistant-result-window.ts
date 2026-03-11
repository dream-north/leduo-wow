import { BrowserWindow, clipboard } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'

export function createAssistantResultWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 520,
    height: 420,
    show: false,
    resizable: true,
    title: '语音助手结果',
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

  return win
}

export function showAssistantResultWindow(win: BrowserWindow | null, text: string): void {
  if (!win || win.isDestroyed()) return

  const send = (): void => {
    win.webContents.send(IPC.ASSISTANT_RESULT_UPDATE, text)
  }

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send)
  } else {
    send()
  }

  win.show()
  win.focus()
}

export function copyAssistantResultText(text: string): void {
  clipboard.writeText(text)
}
