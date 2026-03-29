import { Tray, Menu, nativeImage, app } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { join } from 'path'
import { PipelineStatus } from '../shared/types'
import type { ScreenDocStatus } from '../shared/types'

let tray: Tray | null = null
let trayMenu: Menu | null = null
let onShowSettings: (() => void) | null = null
let onCheckForUpdate: (() => void) | null = null
let getStatus: (() => PipelineStatus) | null = null
let getScreenDocStatus: (() => ScreenDocStatus) | null = null
let onStopScreenDoc: (() => void) | null = null
let onCancelScreenDoc: (() => void) | null = null

export interface TrayCallbacks {
  showSettings: () => void
  checkForUpdate: () => void
  getStatus: () => PipelineStatus
  getScreenDocStatus: () => ScreenDocStatus
  stopScreenDoc: () => void
  cancelScreenDoc: () => void
}

export function createTray(callbacks: TrayCallbacks): Tray | null {
  // If tray already exists, don't create a new one
  if (tray) {
    return tray
  }

  onShowSettings = callbacks.showSettings
  onCheckForUpdate = callbacks.checkForUpdate
  getStatus = callbacks.getStatus
  getScreenDocStatus = callbacks.getScreenDocStatus
  onStopScreenDoc = callbacks.stopScreenDoc
  onCancelScreenDoc = callbacks.cancelScreenDoc

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
    [PipelineStatus.ENHANCING_ASR]: '词汇增强识别中...',
    [PipelineStatus.POLISHING]: '润色中...',
    [PipelineStatus.INPUTTING]: '输入中...',
    [PipelineStatus.CONVERSING]: '对话中',
    [PipelineStatus.ERROR]: '错误'
  }

  const currentStatus = status || getStatus?.() || PipelineStatus.IDLE
  const currentScreenDocStatus = getScreenDocStatus?.() ?? 'idle'
  const isScreenDocActive = currentScreenDocStatus !== 'idle'

  const screenDocLabels: Record<ScreenDocStatus, string> = {
    idle: '就绪',
    recording: '录屏整理中...',
    finalizing: '正在整理录制内容...',
    uploading: '正在上传录屏...',
    analyzing: '正在分析操作过程...',
    ready: '录屏整理已完成',
    error: '录屏整理失败'
  }

  const screenDocActions: MenuItemConstructorOptions[] = []
  if (isScreenDocActive) {
    if (currentScreenDocStatus === 'recording') {
      screenDocActions.push({
        label: '停止录屏整理',
        click: () => onStopScreenDoc?.()
      })
    }

    if (
      currentScreenDocStatus === 'recording' ||
      currentScreenDocStatus === 'finalizing' ||
      currentScreenDocStatus === 'uploading' ||
      currentScreenDocStatus === 'analyzing'
    ) {
      screenDocActions.push({
        label: '取消本次录屏',
        click: () => onCancelScreenDoc?.()
      })
    }

    screenDocActions.push({ type: 'separator' })
  }

  trayMenu = Menu.buildFromTemplate([
    {
      label: isScreenDocActive
        ? `状态: ${screenDocLabels[currentScreenDocStatus]}`
        : `状态: ${statusLabels[currentStatus]}`,
      enabled: false
    },
    { type: 'separator' },
    ...screenDocActions,
    {
      label: '检查更新...',
      click: () => onCheckForUpdate?.()
    },
    {
      label: '设置...',
      accelerator: settingsAccelerator,
      click: () => onShowSettings?.()
    },
    { type: 'separator' },
    {
      label: '退出 乐多汪汪',
      accelerator: quitAccelerator,
      click: () => app.quit()
    }
  ])
}
