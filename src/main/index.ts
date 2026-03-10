import { app, BrowserWindow, shell, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createTray } from './tray'
import { registerIpcHandlers } from './ipc-handlers'
import { initConfigStore, getConfig } from './config-store'
import { ShortcutManager } from './shortcut'
import { Pipeline } from './pipeline'
import { PipelineStatus } from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import { createOverlayWindow } from './overlay-window'
import type { ConfigStore } from './config-store'
import { checkPermissions, requestAccessibilityPermission } from './permissions'

let settingsWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let pipeline: Pipeline | null = null
let configStore: ConfigStore | null = null
let isQuitting = false

// Dock icon visibility state tracking
let lastDockState: boolean | null = null
let dockUpdateTimeout: NodeJS.Timeout | null = null

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
    title: '乐多汪汪 设置',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 10 },
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

export function getSettingsWindow(): BrowserWindow | null {
  return settingsWindow
}

export function getPipeline(): Pipeline | null {
  return pipeline
}

export function getConfigStore(): ConfigStore | null {
  return configStore
}

// Queue for dock visibility updates
let pendingDockState: boolean | null = null

export function updateDockIconVisibility(hideDockIcon: boolean): void {
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

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.leduowow.app')

  // Initialize config store first (before creating any windows)
  configStore = initConfigStore()
  const config = getConfig(configStore)

  // Check accessibility permission for SwiftKeyboardListener
  const permissions = checkPermissions()
  if (!permissions.accessibility) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '需要辅助功能权限',
      message: '乐多汪汪需要辅助功能权限来使用全局快捷键功能。',
      detail: '请点击"打开系统设置"，在左侧列表中找到并勾选"乐多汪汪"，然后重启应用。',
      buttons: ['打开系统设置', '退出应用'],
      defaultId: 0
    })

    if (response === 0) {
      // Open system preferences and request permission
      await requestAccessibilityPermission()
    }
    // Quit app regardless - user needs to restart after granting permission
    app.quit()
    return
  }

  // Control dock icon visibility BEFORE creating any windows
  // This must be done early, otherwise it won't take effect until restart
  if (config.hideDockIcon) {
    app.dock?.hide()
  } else {
    app.dock?.show()
  }
  // Sync the initial state to prevent unnecessary updates
  lastDockState = config.hideDockIcon

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Create windows
  settingsWindow = createSettingsWindow()
  overlayWindow = createOverlayWindow()

  // Initialize pipeline
  pipeline = new Pipeline(overlayWindow, configStore)

  // Initialize shortcut manager
  const shortcutManager = new ShortcutManager(configStore, pipeline)
  shortcutManager.setSettingsWindow(settingsWindow)
  shortcutManager.register()

  // Create tray (always show tray icon)
  createTray({
    showSettings: () => showSettingsWindow(),
    getStatus: () => pipeline?.getStatus() || PipelineStatus.IDLE
  })

  // Register IPC handlers
  registerIpcHandlers(configStore, pipeline, shortcutManager, overlayWindow)

  // Show settings window on first launch
  showSettingsWindow()

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
})

app.on('before-quit', () => {
  isQuitting = true
})

app.on('will-quit', () => {
  // Unregister all shortcuts
  const { globalShortcut } = require('electron')
  globalShortcut.unregisterAll()

  // Stop native keyboard listener
  try {
    const { keyboardListener } = require('../native-keyboard-listener')
    keyboardListener.stop()
  } catch (e) {
    // Ignore if not available
  }
})

app.on('activate', () => {
  showSettingsWindow()
})

app.on('window-all-closed', () => {
  // Keep app running even when all windows closed (menubar app)
})
