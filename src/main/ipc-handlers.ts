import { ipcMain, app, BrowserWindow, clipboard, dialog, shell } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { getConfig, setConfig, getHistory, setHistory, ConfigStore } from './config-store'
import {
  getPersonalVocabulary,
  getSharedVocabulary,
  addVocabularyEntry,
  updateVocabularyEntry,
  deleteVocabularyEntry,
  importVocabularyEntries,
  exportVocabularyEntries,
  getVocabularyStats,
  removeSourceEntries
} from './vocabulary-store'
import type { VocabularyStore } from './vocabulary-store'
import { syncSharedVocabulary, syncFromUrl, previewMerge, executeMerge, testWriteToken } from './vocabulary-sync'
import { parseGitPlatformUrl } from '../shared/types'
import type { VocabMergeItem } from '../shared/types'
import { Pipeline } from './pipeline'
import { ShortcutService } from './shortcut'
import { checkPermissions, requestMicrophonePermission, requestAccessibilityPermission, requestScreenPermission } from './permissions'
import { updateTrayMenu } from './tray'
import { getRunningApps } from './macos-apps'
import { updateDockIconVisibility } from './index'
import type { ShortcutServiceStatus } from '../shared/types'
import { getLatestAssistantResultPayload, markAssistantResultWindowReady } from './assistant-result-window'
import { checkForUpdatesManual, downloadUpdate, installUpdate, getUpdateStatus } from './updater'

export function registerIpcHandlers(
  configStore: ConfigStore,
  pipeline: Pipeline,
  shortcutService: ShortcutService,
  overlayWindow: BrowserWindow | null,
  getAssistantResultWindow: () => BrowserWindow | null,
  vocabularyStore: VocabularyStore
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
    if (key === 'hideDockIcon' && process.platform === 'darwin') {
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

  ipcMain.handle(IPC.SHORTCUT_ENSURE_NATIVE_READY, async () => {
    return await shortcutService.ensureNativeBackendReady()
  })

  ipcMain.handle(IPC.SHORTCUT_CAPTURE_SET, (_event, active: boolean) => {
    shortcutService.setShortcutCaptureActive(active)
    return true
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

  // Running apps list (macOS)
  ipcMain.handle(IPC.APP_GET_RUNNING_APPS, () => {
    return getRunningApps()
  })

  ipcMain.on(IPC.ASSISTANT_RESULT_COPY, (_event, text: string) => {
    clipboard.writeText(text)
  })

  ipcMain.on(IPC.ASSISTANT_RESULT_READY, (event) => {
    const assistantResultWindow = BrowserWindow.fromWebContents(event.sender)
    if (!assistantResultWindow || assistantResultWindow.isDestroyed()) {
      return
    }

    markAssistantResultWindowReady(assistantResultWindow)
  })

  ipcMain.handle(IPC.ASSISTANT_RESULT_GET_LATEST, () => {
    const assistantResultWindow = getAssistantResultWindow()
    if (!assistantResultWindow || assistantResultWindow.isDestroyed()) {
      return null
    }

    return getLatestAssistantResultPayload(assistantResultWindow)
  })

  ipcMain.on(IPC.ASSISTANT_RESULT_CLOSE, () => {
    const assistantResultWindow = getAssistantResultWindow()
    if (assistantResultWindow && !assistantResultWindow.isDestroyed()) {
      const [x, y] = assistantResultWindow.getPosition()
      const [width, height] = assistantResultWindow.getSize()
      pipeline.handleAssistantResultWindowClosed({ x, y }, { width, height })
    } else {
      pipeline.handleAssistantResultWindowClosed()
    }
  })

  // Vocabulary handlers
  ipcMain.handle(IPC.VOCABULARY_GET_PERSONAL, () => {
    return getPersonalVocabulary(vocabularyStore)
  })

  ipcMain.handle(IPC.VOCABULARY_GET_SHARED, () => {
    return getSharedVocabulary(vocabularyStore)
  })

  ipcMain.handle(
    IPC.VOCABULARY_ADD,
    (_event, source: 'personal' | 'shared', entry: { term: string; description?: string; category?: string }) => {
      return addVocabularyEntry(vocabularyStore, source, {
        term: entry.term,
        description: entry.description || '',
        category: entry.category || '',
        enabled: true
      })
    }
  )

  ipcMain.handle(
    IPC.VOCABULARY_UPDATE,
    (_event, source: 'personal' | 'shared', id: string, updates: Record<string, unknown>) => {
      return updateVocabularyEntry(vocabularyStore, source, id, updates)
    }
  )

  ipcMain.handle(IPC.VOCABULARY_DELETE, (_event, source: 'personal' | 'shared', id: string) => {
    return deleteVocabularyEntry(vocabularyStore, source, id)
  })

  ipcMain.handle(
    IPC.VOCABULARY_IMPORT,
    (_event, source: 'personal' | 'shared', entries: Array<{ term: string; description?: string; category?: string }>) => {
      return importVocabularyEntries(vocabularyStore, source, entries)
    }
  )

  ipcMain.handle(IPC.VOCABULARY_EXPORT, (_event, source: 'personal' | 'shared', name?: string) => {
    return exportVocabularyEntries(vocabularyStore, source, name)
  })

  ipcMain.handle(IPC.VOCABULARY_GET_STATS, () => {
    return getVocabularyStats(vocabularyStore)
  })

  ipcMain.handle(IPC.VOCABULARY_SYNC_SHARED, async () => {
    const config = getConfig(configStore)
    return await syncSharedVocabulary(vocabularyStore, config)
  })

  ipcMain.handle(IPC.VOCABULARY_SYNC_URL, async (_event, url: string, token?: string) => {
    // Use provided token first (e.g. during initial add), fallback to saved writeToken
    const config = getConfig(configStore)
    const source = config.sharedVocabSyncSources.find((s) => s.url === url)
    return await syncFromUrl(vocabularyStore, url, token || source?.writeToken)
  })

  ipcMain.handle(IPC.VOCABULARY_REMOVE_SOURCE, (_event, sourceUrl: string) => {
    removeSourceEntries(vocabularyStore, sourceUrl)
  })

  // Vocabulary merge (push to remote)
  ipcMain.handle(IPC.VOCABULARY_PREVIEW_MERGE, async (_event, sourceUrl: string) => {
    const config = getConfig(configStore)
    const source = config.sharedVocabSyncSources.find((s) => s.url === sourceUrl)
    const platformInfo = parseGitPlatformUrl(sourceUrl)
    if (!platformInfo)
      return { items: [], newCount: 0, conflictCount: 0, unchangedCount: 0, remoteOnlyCount: 0, error: '不支持的平台' }
    const token = source?.writeToken
    if (!token)
      return { items: [], newCount: 0, conflictCount: 0, unchangedCount: 0, remoteOnlyCount: 0, error: '未配置写入凭证' }
    try {
      return await previewMerge(vocabularyStore, platformInfo, token)
    } catch (err) {
      return { items: [], newCount: 0, conflictCount: 0, unchangedCount: 0, remoteOnlyCount: 0, error: (err as Error).message }
    }
  })

  ipcMain.handle(
    IPC.VOCABULARY_EXECUTE_MERGE,
    async (_event, sourceUrl: string, resolvedItems: VocabMergeItem[]) => {
      const config = getConfig(configStore)
      const source = config.sharedVocabSyncSources.find((s) => s.url === sourceUrl)
      const platformInfo = parseGitPlatformUrl(sourceUrl)
      if (!platformInfo) return { success: false, error: '不支持的平台' }
      const token = source?.writeToken
      if (!token) return { success: false, error: '未配置写入凭证' }
      return await executeMerge(vocabularyStore, sourceUrl, platformInfo, token, resolvedItems)
    }
  )

  ipcMain.handle(IPC.VOCABULARY_TEST_WRITE_TOKEN, async (_event, sourceUrl: string, token: string) => {
    const platformInfo = parseGitPlatformUrl(sourceUrl)
    if (!platformInfo) return { success: false, error: '不支持的平台' }
    return await testWriteToken(platformInfo, token)
  })

  // Auto-update
  ipcMain.handle(IPC.UPDATE_CHECK, () => checkForUpdatesManual())
  ipcMain.handle(IPC.UPDATE_DOWNLOAD, () => downloadUpdate())
  ipcMain.handle(IPC.UPDATE_INSTALL, () => installUpdate())
  ipcMain.handle(IPC.UPDATE_STATUS, () => getUpdateStatus())
}
