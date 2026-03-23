import { app, BrowserWindow, Menu, shell } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createTray } from './tray'
import { registerIpcHandlers } from './ipc-handlers'
import { initConfigStore, getConfig } from './config-store'
import { ShortcutService } from './shortcut'
import { Pipeline } from './pipeline'
import { PipelineStatus } from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import { createOverlayWindow } from './overlay-window'
import { OverlayManager } from './overlay-manager'
import type { ConfigStore } from './config-store'
import { checkPermissions } from './permissions'
import { keyboardListener } from '../native-keyboard-listener'
import { initAutoUpdater, checkForUpdatesManual } from './updater'

const gotSingleInstanceLock = app.requestSingleInstanceLock()

let settingsWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let assistantResultWindow: BrowserWindow | null = null
let overlayManager: OverlayManager | null = null
let pipeline: Pipeline | null = null
let configStore: ConfigStore | null = null
let shortcutService: ShortcutService | null = null
let isQuitting = false

// Dock icon visibility state tracking
let lastDockState: boolean | null = null
let dockUpdateTimeout: NodeJS.Timeout | null = null

function getWindowsWindowIconPath(): string | undefined {
  if (process.platform !== 'win32') return undefined
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../build/icon.ico')
}

function attachWindowDebugLogging(win: BrowserWindow, name: string): void {
  if (!is.dev) return

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Window:${name}:console:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    console.error(`[Window:${name}:did-fail-load] code=${errorCode} mainFrame=${isMainFrame} url=${validatedURL} error=${errorDescription}`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[Window:${name}:render-process-gone] reason=${details.reason} exitCode=${details.exitCode}`)
  })

  win.webContents.on('did-finish-load', () => {
    const currentUrl = win.webContents.getURL()
    console.log(`[Window:${name}:did-finish-load] ${currentUrl}`)

    setTimeout(() => {
      void win.webContents.executeJavaScript(`
        (() => {
          const app = document.getElementById('app')
          return {
            href: window.location.href,
            title: document.title,
            readyState: document.readyState,
            bodyChildCount: document.body.children.length,
            appExists: !!app,
            appChildCount: app ? app.childElementCount : -1,
            bodyTextLength: (document.body.innerText || '').length
          }
        })()
      `, true).then((snapshot) => {
        console.log(`[Window:${name}:dom-snapshot] ${JSON.stringify(snapshot)}`)
      }).catch((error) => {
        console.error(`[Window:${name}:dom-snapshot-error]`, error)
      })
    }, 300)
  })
}

// Notify renderer about dock update lock state
function notifyDockUpdateLock(locked: boolean): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(IPC.DOCK_UPDATE_LOCK, locked)
  }
}

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    resizable: true,
    autoHideMenuBar: process.platform !== 'darwin',
    icon: getWindowsWindowIconPath(),
    title: '乐多汪汪 设置',
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 15, y: 10 }
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })

  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.platform !== 'darwin') {
    win.removeMenu()
    win.setMenuBarVisibility(false)
  }

  attachWindowDebugLogging(win, 'settings')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

export function showSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
  }
}

export function getOverlayWindow(): BrowserWindow | null {
  return overlayWindow
}

export function getAssistantResultWindow(): BrowserWindow | null {
  return assistantResultWindow
}

export function getOverlayManager(): OverlayManager | null {
  return overlayManager
}

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}

export function getPipeline(): Pipeline | null {
  return pipeline
}

export function getConfigStore(): ConfigStore | null {
  return configStore
}

export function getShortcutService(): ShortcutService | null {
  return shortcutService
}

// Queue for dock visibility updates
let pendingDockState: boolean | null = null

export function updateDockIconVisibility(hideDockIcon: boolean): void {
  if (process.platform !== 'darwin') {
    return
  }

  // Skip if state hasn't changed and no pending update
  if (lastDockState === hideDockIcon && pendingDockState === null) {
    return
  }

  // Store the latest requested state
  pendingDockState = hideDockIcon

  // Clear any pending update
  if (dockUpdateTimeout) {
    clearTimeout(dockUpdateTimeout)
  }

  // Debounce the dock update to prevent rapid switching issues
  // Use pendingDockState to always apply the latest requested state
  dockUpdateTimeout = setTimeout(() => {
    if (pendingDockState === null) return

    const targetState = pendingDockState
    pendingDockState = null

    // Lock the UI during update
    notifyDockUpdateLock(true)

    // Control dock icon visibility directly based on the passed value
    // Note: dock.show() only works reliably if called before windows are created
    // For hiding, it works at any time
    if (targetState) {
      app.dock?.hide()
    } else {
      // Showing dock after windows are created may not work immediately
      // A restart is recommended for the change to take full effect
      // Use try-catch as dock.show() can sometimes cause issues
      try {
        app.dock?.show()
      } catch (e) {
        console.log('[Dock] Failed to show dock icon:', e)
      }
    }
    lastDockState = targetState
    dockUpdateTimeout = null

    // Unlock the UI after a delay to prevent rapid switching
    setTimeout(() => {
      notifyDockUpdateLock(false)
    }, 1000)
  }, 30)
}

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const focusExistingInstance = (): void => {
      if (settingsWindow?.isMinimized()) {
        settingsWindow.restore()
      }

      showSettingsWindow()
      shortcutService?.refresh()
    }

    if (app.isReady()) {
      focusExistingInstance()
      return
    }

    void app.whenReady().then(() => {
      focusExistingInstance()
    })
  })

  app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.leduowow.app')

  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
  }

  // Initialize config store first (before creating any windows)
  configStore = initConfigStore()
  const config = getConfig(configStore)

  checkPermissions()

  if (process.platform === 'darwin') {
    // Control dock icon visibility BEFORE creating any windows
    // This must be done early, otherwise it won't take effect until restart
    if (config.hideDockIcon) {
      app.dock?.hide()
    } else {
      app.dock?.show()
    }

    // Sync the initial state to prevent unnecessary updates
    lastDockState = config.hideDockIcon
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Create windows
  settingsWindow = createSettingsWindow()
  overlayWindow = createOverlayWindow()
  overlayManager = new OverlayManager({
    overlayWindow,
    getAssistantResultWindow: () => assistantResultWindow,
    setAssistantResultWindow: (window) => {
      if (window && window !== assistantResultWindow) {
        attachWindowDebugLogging(window, 'assistant-result')
      }
      assistantResultWindow = window
    }
  })

  // Initialize pipeline
  pipeline = new Pipeline(overlayManager, configStore)
  keyboardListener.onOverlayResultClosed((position, size) => {
    pipeline?.handleAssistantResultWindowClosed(position, size)
  })

  // Initialize shortcut service
  shortcutService = new ShortcutService(configStore, pipeline)
  shortcutService.start()

  // Create tray (always show tray icon)
  createTray({
    showSettings: () => showSettingsWindow(),
    checkForUpdate: () => checkForUpdatesManual(),
    getStatus: () => pipeline?.getStatus() || PipelineStatus.IDLE
  })

  // Register IPC handlers
  registerIpcHandlers(configStore, pipeline, shortcutService, overlayWindow, () => assistantResultWindow)

  // Initialize auto-updater
  initAutoUpdater()

  // Show settings window on first launch
  showSettingsWindow()

  if (process.platform === 'darwin') {
    // Delayed check to ensure dock icon visibility matches config
    // This handles cases where LSUIElement or initial dock.hide() didn't work
    setTimeout(() => {
      if (!configStore) return
      const currentConfig = getConfig(configStore)
      console.log('[Dock] Delayed check - hideDockIcon:', currentConfig.hideDockIcon)
      // Force update dock visibility
      lastDockState = null // Reset state to force update
      updateDockIconVisibility(currentConfig.hideDockIcon)
    }, 1000)
  }

  app.on('browser-window-focus', () => {
    shortcutService?.refresh()
  })
  })
}

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  overlayManager?.destroy()
  shortcutService?.destroy()
})

app.on('activate', () => {
  showSettingsWindow()
  shortcutService?.refresh()
})

app.on('window-all-closed', () => {
  // Keep app running even when all windows closed (menubar app)
})


