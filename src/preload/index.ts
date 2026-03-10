import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

const electronAPI = {
  // Config
  getConfig: () => ipcRenderer.invoke(IPC.CONFIG_GET_ALL),
  getConfigValue: (key: string) => ipcRenderer.invoke(IPC.CONFIG_GET, key),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke(IPC.CONFIG_SET, key, value),

  // Shortcut recording
  startShortcutRecord: (mode?: 'transcription' | 'assistant') => ipcRenderer.invoke(IPC.SHORTCUT_RECORD_START, mode),
  stopShortcutRecord: (mode?: 'transcription' | 'assistant', newShortcut?: string) => ipcRenderer.invoke(IPC.SHORTCUT_RECORD_STOP, mode, newShortcut),

  // Permissions
  checkPermissions: () => ipcRenderer.invoke(IPC.PERMISSIONS_CHECK),
  requestPermission: (type: string) => ipcRenderer.invoke(IPC.PERMISSIONS_REQUEST, type),

  // Pipeline status
  onPipelineStatus: (callback: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) => callback(status)
    ipcRenderer.on(IPC.PIPELINE_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.PIPELINE_STATUS, handler)
  },
  onPartialText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on(IPC.PIPELINE_PARTIAL_TEXT, handler)
    return () => ipcRenderer.removeListener(IPC.PIPELINE_PARTIAL_TEXT, handler)
  },
  onFinalText: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on(IPC.PIPELINE_FINAL_TEXT, handler)
    return () => ipcRenderer.removeListener(IPC.PIPELINE_FINAL_TEXT, handler)
  },
  onError: (callback: (error: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: string) => callback(error)
    ipcRenderer.on(IPC.PIPELINE_ERROR, handler)
    return () => ipcRenderer.removeListener(IPC.PIPELINE_ERROR, handler)
  },

  // App
  getVersion: () => ipcRenderer.invoke(IPC.APP_GET_VERSION),

  // History
  getHistory: () => ipcRenderer.invoke('history:get'),
  onHistoryUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.HISTORY_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC.HISTORY_UPDATED, handler)
  },

  // Dialog
  selectFolder: () => ipcRenderer.invoke(IPC.DIALOG_SELECT_FOLDER) as Promise<string>,

  // Shell
  openPath: (path: string) => ipcRenderer.invoke(IPC.SHELL_OPEN_PATH, path) as Promise<string>,

  // Apps
  getRunningApps: () => ipcRenderer.invoke(IPC.APP_GET_RUNNING_APPS) as Promise<Array<{ name: string; bundleId: string }>>,

  // Keyboard events from Swift (for shortcut recording)
  onKeyboardEvent: (callback: (event: KeyboardEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: KeyboardEvent) => callback(data)
    ipcRenderer.on(IPC.KEYBOARD_EVENT, handler)
    return () => ipcRenderer.removeListener(IPC.KEYBOARD_EVENT, handler)
  },

  // Dock update lock
  onDockUpdateLock: (callback: (locked: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, locked: boolean) => callback(locked)
    ipcRenderer.on(IPC.DOCK_UPDATE_LOCK, handler)
    return () => ipcRenderer.removeListener(IPC.DOCK_UPDATE_LOCK, handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
