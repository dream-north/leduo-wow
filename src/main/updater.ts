import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import { IPC } from '../shared/ipc-channels'
import type { UpdateStatus, UpdateStatusPayload } from '../shared/types'

let currentStatus: UpdateStatus = 'idle'
let errorResetTimeout: NodeJS.Timeout | null = null

function broadcastStatus(payload: UpdateStatusPayload): void {
  currentStatus = payload.status
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.UPDATE_STATUS, payload)
    }
  }
}

function makePayload(status: UpdateStatus, extra?: Partial<UpdateStatusPayload>): UpdateStatusPayload {
  return {
    status,
    currentVersion: app.getVersion(),
    ...extra
  }
}

function scheduleErrorReset(): void {
  if (errorResetTimeout) clearTimeout(errorResetTimeout)
  errorResetTimeout = setTimeout(() => {
    if (currentStatus === 'error') {
      broadcastStatus(makePayload('idle'))
    }
    errorResetTimeout = null
  }, 30_000)
}

export function initAutoUpdater(): void {
  if (is.dev) {
    console.log('[Updater] Skipping auto-update init in dev mode')
    return
  }

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false

  autoUpdater.on('checking-for-update', () => {
    broadcastStatus(makePayload('checking'))
  })

  autoUpdater.on('update-available', (info) => {
    const notes = typeof info.releaseNotes === 'string'
      ? info.releaseNotes
      : Array.isArray(info.releaseNotes)
        ? info.releaseNotes.map((n) => n.note).join('\n')
        : undefined
    broadcastStatus(makePayload('available', {
      newVersion: info.version,
      releaseNotes: notes
    }))
  })

  autoUpdater.on('update-not-available', () => {
    broadcastStatus(makePayload('not-available'))
  })

  autoUpdater.on('download-progress', (progress) => {
    broadcastStatus(makePayload('downloading', {
      progress: Math.round(progress.percent)
    }))
  })

  autoUpdater.on('update-downloaded', (info) => {
    broadcastStatus(makePayload('downloaded', {
      newVersion: info.version
    }))
  })

  autoUpdater.on('error', (err) => {
    console.error('[Updater] Error:', err.message)
    broadcastStatus(makePayload('error', {
      error: err.message
    }))
    scheduleErrorReset()
  })

  // Auto-check after startup delay
  setTimeout(() => {
    console.log('[Updater] Auto-checking for updates...')
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[Updater] Auto-check failed:', err.message)
    })
  }, 10_000)
}

export function getUpdateStatus(): UpdateStatusPayload {
  return makePayload(currentStatus)
}

export function checkForUpdatesManual(): UpdateStatusPayload {
  if (is.dev) {
    return makePayload('error', { error: '开发模式下不检查更新' })
  }
  if (currentStatus === 'checking' || currentStatus === 'downloading') {
    return makePayload(currentStatus)
  }
  broadcastStatus(makePayload('checking'))
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[Updater] Manual check failed:', err.message)
  })
  return makePayload('checking')
}

export function downloadUpdate(): void {
  if (currentStatus !== 'available') return
  autoUpdater.downloadUpdate().catch((err) => {
    console.error('[Updater] Download failed:', err.message)
  })
}

export function installUpdate(): void {
  if (currentStatus !== 'downloaded') return
  console.log('[Updater] Installing update and restarting...')
  // Delay to let IPC response reach renderer before app quits.
  // Pass (false, true): isSilent=false, isForceRunAfter=true
  // so macOS properly restarts after update.
  setTimeout(() => {
    // Remove close event listeners from all windows to prevent them
    // from blocking the quit process. Settings window and assistant result
    // window both use e.preventDefault() in their close handlers to hide
    // instead of close, which can prevent app.quit() (called internally
    // by quitAndInstall) from completing.
    for (const win of BrowserWindow.getAllWindows()) {
      win.removeAllListeners('close')
    }

    autoUpdater.quitAndInstall(false, true)

    // Safety net: if quitAndInstall didn't terminate the process,
    // force exit so the app doesn't linger.
    setTimeout(() => {
      console.log('[Updater] Force exiting as safety net...')
      app.exit(0)
    }, 3000)
  }, 100)
}
