import { ipcMain, app, BrowserWindow, dialog, shell } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { getConfig, setConfig, getHistory, setHistory, ConfigStore } from './config-store'
import { Pipeline } from './pipeline'
import { ShortcutService } from './shortcut'
import { checkPermissions, requestMicrophonePermission, requestAccessibilityPermission, requestScreenPermission } from './permissions'
import { updateTrayMenu } from './tray'
import { getRunningApps } from './macos-apps'
import { updateDockIconVisibility } from './index'
import { copyAssistantResultText } from './assistant-result-window'
import type { ShortcutServiceStatus } from '../shared/types'

export function registerIpcHandlers(
  configStore: ConfigStore,
  pipeline: Pipeline,
  shortcutService: ShortcutService,
  overlayWindow: BrowserWindow | null,
  assistantResultWindow: BrowserWindow | null
): void {
  shortcutService.on('status-changed', ({ status }: { status: ShortcutServiceStatus }) => {
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.SHORTCUT_STATUS_CHANGED, status)
      }
    })
  })

  // Config handlers
  ipcMain.handle(IPC.CONFIG_GET_ALL, () => {
    return getConfig(configStore)
  })

  ipcMain.handle(IPC.CONFIG_GET, (_event, key: string) => {
    const config = getConfig(configStore)
    return config[key as keyof typeof config]
  })

  ipcMain.handle(IPC.CONFIG_SET, (_event, key: string, value: unknown) => {
    setConfig(configStore, key, value)

    // Handle side effects
    if (key === 'shortcut' || key === 'transcriptionShortcut') {
      shortcutService.updateShortcut('transcription', value as string)
    }
    if (key === 'assistantShortcut') {
      shortcutService.updateShortcut('assistant', value as string)
    }
    if (key === 'launchAtLogin') {
      app.setLoginItemSettings({
        openAtLogin: value as boolean,
        openAsHidden: true
      })
    }
    if (key === 'audioThreshold' && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.AUDIO_THRESHOLD, value as number)
    }
    if (key === 'hideDockIcon') {
      updateDockIconVisibility(value as boolean)
    }
    if (key === 'historyMaxCount') {
      // Trim history to new max count
      const maxCount = value as number
      const history = getHistory(configStore)
      if (history.length > maxCount) {
        const trimmed = history.slice(0, maxCount)
        setHistory(configStore, trimmed)
        // Notify windows that history has been updated
        BrowserWindow.getAllWindows().forEach((win) => {
          win.webContents.send(IPC.HISTORY_UPDATED)
        })
      }
    }

    return true
  })

  ipcMain.handle(IPC.SHORTCUT_STATUS_GET, () => {
    return shortcutService.getStatus()
  })

  ipcMain.handle(IPC.SHORTCUT_REFRESH, () => {
    return shortcutService.refresh()
  })

  // Pipeline status listener
  pipeline.on('status', (status) => {
    updateTrayMenu(status)
  })

  // Audio chunk from overlay renderer
  ipcMain.on(IPC.AUDIO_CHUNK, (_event, chunk: ArrayBuffer) => {
    pipeline.appendAudioChunk(Buffer.from(chunk))
  })

  // Audio capture error from overlay renderer
  ipcMain.on(IPC.AUDIO_CAPTURE_ERROR, (_event, message: string) => {
    pipeline.handleAudioCaptureError(message)
  })

  // Permissions
  ipcMain.handle(IPC.PERMISSIONS_CHECK, () => {
    return checkPermissions()
  })

  ipcMain.handle(IPC.PERMISSIONS_REQUEST, async (_event, type: string) => {
    if (type === 'microphone') {
      return await requestMicrophonePermission()
    } else if (type === 'accessibility') {
      const granted = await requestAccessibilityPermission()
      shortcutService.refresh()
      if (!granted) {
        shortcutService.beginAccessibilityPolling()
      }
      return granted
    } else if (type === 'screen') {
      return await requestScreenPermission()
    }
    return false
  })

  // App info
  ipcMain.handle(IPC.APP_GET_VERSION, () => {
    return app.getVersion()
  })

  // History
  ipcMain.handle('history:get', () => {
    return getHistory(configStore)
  })

  // Folder picker dialog
  ipcMain.handle(IPC.DIALOG_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })

  // Shell: open path in Finder
  ipcMain.handle(IPC.SHELL_OPEN_PATH, (_event, path: string) => {
    return shell.openPath(path)
  })


  ipcMain.handle(IPC.ASSISTANT_RESULT_COPY, (_event, text: string) => {
    copyAssistantResultText(text)
    return true
  })

  ipcMain.handle(IPC.ASSISTANT_RESULT_CLOSE, () => {
    if (assistantResultWindow && !assistantResultWindow.isDestroyed()) {
      assistantResultWindow.hide()
    }
    return true
  })

  // Running apps list (macOS)
  ipcMain.handle(IPC.APP_GET_RUNNING_APPS, () => {
    return getRunningApps()
  })
}
