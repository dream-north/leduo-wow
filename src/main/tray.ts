import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'path'
import { PipelineStatus } from '../shared/types'

let tray: Tray | null = null
let trayMenu: Menu | null = null
let onShowSettings: (() => void) | null = null
let getStatus: (() => PipelineStatus) | null = null

export interface TrayCallbacks {
  showSettings: () => void
  getStatus: () => PipelineStatus
}

export function createTray(callbacks: TrayCallbacks): Tray | null {
  // If tray already exists, don't create a new one
  if (tray) {
    return tray
  }

  onShowSettings = callbacks.showSettings
  getStatus = callbacks.getStatus

  // Load Border Collie icon — use @2x for crisp retina display
  const iconPath = app.isPackaged
    ? join(process.resourcesPath, 'build', 'tray-icon@2x.png')
    : join(__dirname, '../../build/tray-icon@2x.png')

  let icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    console.warn('[Tray] Icon not found at', iconPath, ', using fallback')
    icon = nativeImage.createEmpty()
  } else {
    icon = icon.resize({ width: 18, height: 18 })
    icon.setTemplateImage(true)
  }

  tray = new Tray(icon)
  tray.setToolTip('乐多汪汪')

  // Do NOT use setContextMenu — it overrides click events on macOS.
  // Instead, handle clicks manually.
  tray.on('click', () => {
    onShowSettings?.()
  })

  tray.on('right-click', () => {
    if (trayMenu) {
      tray?.popUpContextMenu(trayMenu)
    }
  })

  updateTrayMenu()

  return tray
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
  trayMenu = null
}

export function updateTrayMenu(status?: PipelineStatus): void {
  if (!tray) return

  const settingsAccelerator = process.platform === 'darwin' ? 'Command+,' : 'Ctrl+,'
  const quitAccelerator = process.platform === 'darwin' ? 'Command+Q' : 'Alt+F4'

  const statusLabels: Record<PipelineStatus, string> = {
    [PipelineStatus.IDLE]: '就绪',
    [PipelineStatus.RECORDING]: '🎤 录音中...',
    [PipelineStatus.FINALIZING_ASR]: '识别中...',
    [PipelineStatus.POLISHING]: '润色中...',
    [PipelineStatus.INPUTTING]: '输入中...',
    [PipelineStatus.ERROR]: '错误'
  }

  const currentStatus = status || getStatus?.() || PipelineStatus.IDLE

  trayMenu = Menu.buildFromTemplate([
    {
      label: `状态: ${statusLabels[currentStatus]}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: '设置...',
      accelerator: settingsAccelerator,
      click: () => onShowSettings?.()
    },
    { type: 'separator' },
    {
      label: '退出 乐多汪汪',
      accelerator: quitAccelerator,
      click: () => app.exit(0)
    }
  ])
}
