import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { ScreenDocHistoryRecord, ScreenDocResultPayload, ScreenDocStatusPayload } from '../shared/types'

const electronAPI = {
  platform: process.platform,
  // Config
  getConfig: () => ipcRenderer.invoke(IPC.CONFIG_GET_ALL),
  getConfigValue: (key: string) => ipcRenderer.invoke(IPC.CONFIG_GET, key),
  setConfig: (key: string, value: unknown) => ipcRenderer.invoke(IPC.CONFIG_SET, key, value),

  getShortcutStatus: () => ipcRenderer.invoke(IPC.SHORTCUT_STATUS_GET),
  refreshShortcutStatus: () => ipcRenderer.invoke(IPC.SHORTCUT_REFRESH),
  ensureNativeBackendReady: () => ipcRenderer.invoke(IPC.SHORTCUT_ENSURE_NATIVE_READY) as Promise<boolean>,
  setShortcutCaptureActive: (active: boolean) => ipcRenderer.invoke(IPC.SHORTCUT_CAPTURE_SET, active) as Promise<boolean>,

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

  onShortcutStatusChanged: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status)
    ipcRenderer.on(IPC.SHORTCUT_STATUS_CHANGED, handler)
    return () => ipcRenderer.removeListener(IPC.SHORTCUT_STATUS_CHANGED, handler)
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
  // Dock update lock
  onDockUpdateLock: (callback: (locked: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, locked: boolean) => callback(locked)
    ipcRenderer.on(IPC.DOCK_UPDATE_LOCK, handler)
    return () => ipcRenderer.removeListener(IPC.DOCK_UPDATE_LOCK, handler)
  },

  // Auto-update
  checkForUpdate: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  downloadUpdate: () => ipcRenderer.invoke(IPC.UPDATE_DOWNLOAD),
  installUpdate: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.UPDATE_STATUS),
  onUpdateStatus: (callback: (payload: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload)
    ipcRenderer.on(IPC.UPDATE_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, handler)
  },

  // Screen doc
  startScreenDoc: () => ipcRenderer.invoke(IPC.SCREEN_DOC_START) as Promise<{ ok: boolean; error?: string }>,
  getScreenDocStatus: () => ipcRenderer.invoke(IPC.SCREEN_DOC_STATUS_GET) as Promise<ScreenDocStatusPayload>,
  stopScreenDoc: () => ipcRenderer.invoke(IPC.SCREEN_DOC_STOP) as Promise<ScreenDocResultPayload | null>,
  cancelScreenDoc: () => ipcRenderer.invoke(IPC.SCREEN_DOC_CANCEL) as Promise<boolean>,
  sendScreenDocAudioChunk: (chunk: ArrayBuffer) => {
    ipcRenderer.send(IPC.SCREEN_DOC_AUDIO_CHUNK, chunk)
  },
  getScreenDocHistory: () => ipcRenderer.invoke(IPC.SCREEN_DOC_HISTORY_GET) as Promise<ScreenDocHistoryRecord[]>,
  getScreenDocHistoryRecord: (recordId: string) =>
    ipcRenderer.invoke(IPC.SCREEN_DOC_HISTORY_ITEM_GET, recordId) as Promise<ScreenDocHistoryRecord | null>,
  exportScreenDocRecord: (recordId: string) => ipcRenderer.invoke(IPC.SCREEN_DOC_EXPORT, recordId) as Promise<string | null>,
  getLatestScreenDocResult: () => ipcRenderer.invoke(IPC.SCREEN_DOC_RESULT_GET_LATEST) as Promise<ScreenDocResultPayload | null>,
  onScreenDocStatus: (callback: (payload: ScreenDocStatusPayload) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: ScreenDocStatusPayload) => callback(payload)
    ipcRenderer.on(IPC.SCREEN_DOC_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.SCREEN_DOC_STATUS, handler)
  },
  onScreenDocHistoryUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.SCREEN_DOC_HISTORY_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC.SCREEN_DOC_HISTORY_UPDATED, handler)
  },

  // Vocabulary
  getPersonalVocabulary: () => ipcRenderer.invoke(IPC.VOCABULARY_GET_PERSONAL),
  getSharedVocabulary: () => ipcRenderer.invoke(IPC.VOCABULARY_GET_SHARED),
  addVocabulary: (source: string, entry: { term: string; description?: string; category?: string }) =>
    ipcRenderer.invoke(IPC.VOCABULARY_ADD, source, entry),
  updateVocabulary: (source: string, id: string, updates: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC.VOCABULARY_UPDATE, source, id, updates),
  deleteVocabulary: (source: string, id: string) =>
    ipcRenderer.invoke(IPC.VOCABULARY_DELETE, source, id),
  importVocabulary: (source: string, entries: Array<{ term: string; description?: string; category?: string }>) =>
    ipcRenderer.invoke(IPC.VOCABULARY_IMPORT, source, entries),
  exportVocabulary: (source: string, name?: string) => ipcRenderer.invoke(IPC.VOCABULARY_EXPORT, source, name),
  getVocabularyStats: () => ipcRenderer.invoke(IPC.VOCABULARY_GET_STATS),
  syncSharedVocabulary: () => ipcRenderer.invoke(IPC.VOCABULARY_SYNC_SHARED),
  syncVocabularyFromUrl: (url: string, token?: string) =>
    ipcRenderer.invoke(IPC.VOCABULARY_SYNC_URL, url, token),
  removeVocabularySource: (sourceUrl: string) => ipcRenderer.invoke(IPC.VOCABULARY_REMOVE_SOURCE, sourceUrl),
  previewMerge: (sourceUrl: string) => ipcRenderer.invoke(IPC.VOCABULARY_PREVIEW_MERGE, sourceUrl),
  executeMerge: (sourceUrl: string, resolvedItems: unknown[]) =>
    ipcRenderer.invoke(IPC.VOCABULARY_EXECUTE_MERGE, sourceUrl, resolvedItems),
  testWriteToken: (sourceUrl: string, token: string) =>
    ipcRenderer.invoke(IPC.VOCABULARY_TEST_WRITE_TOKEN, sourceUrl, token),
  onVocabularyUpdated: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.VOCABULARY_UPDATED, handler)
    return () => ipcRenderer.removeListener(IPC.VOCABULARY_UPDATED, handler)
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)

export type ElectronAPI = typeof electronAPI
