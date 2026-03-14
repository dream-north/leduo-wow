import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'
import { parkOverlayWindow, positionOverlayAtCursor } from './overlay-window'
import {
  createAssistantResultWindow,
  hideAssistantResultWindow,
  showAssistantResultWindow
} from './assistant-result-window'

interface ElectronOverlayBackendOptions {
  overlayWindow: BrowserWindow | null
  getAssistantResultWindow?: () => BrowserWindow | null
  setAssistantResultWindow?: (window: BrowserWindow | null) => void
}

export class ElectronOverlayBackend implements OverlayBackend {
  readonly id = 'electron'

  constructor(private readonly options: ElectronOverlayBackendOptions) {}

  start(): boolean {
    return this.isAvailable()
  }

  destroy(): void {
    this.dismissAll()
  }

  isAvailable(): boolean {
    const { overlayWindow } = this.options
    return !!overlayWindow && !overlayWindow.isDestroyed()
  }

  showHud(payload: OverlayHudPayload): void {
    this.updateHud(payload)
  }

  updateHud(payload: OverlayHudPayload): void {
    const { overlayWindow } = this.options
    if (!overlayWindow || overlayWindow.isDestroyed()) return

    positionOverlayAtCursor(overlayWindow)
    overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    overlayWindow.showInactive()
    overlayWindow.moveTop()
    overlayWindow.webContents.send(IPC.OVERLAY_UPDATE, payload)
  }

  hideHud(): void {
    const { overlayWindow } = this.options
    if (!overlayWindow || overlayWindow.isDestroyed()) return

    overlayWindow.hide()
    parkOverlayWindow(overlayWindow)
    overlayWindow.webContents.send(IPC.OVERLAY_UPDATE, {
      text: '',
      mode: 'recording',
      voiceMode: 'transcription',
      screenshotActive: false
    })
  }

  showResult(payload: OverlayResultPayload): void {
    const assistantResultWindow = this.getOrCreateAssistantResultWindow()
    if (!assistantResultWindow || assistantResultWindow.isDestroyed()) return
    showAssistantResultWindow(assistantResultWindow, payload.text)
  }

  hideResult(): void {
    const assistantResultWindow = this.options.getAssistantResultWindow?.() ?? null
    if (!assistantResultWindow || assistantResultWindow.isDestroyed()) return
    hideAssistantResultWindow(assistantResultWindow)
  }

  dismissAll(): void {
    this.hideHud()
    this.hideResult()
  }

  private getOrCreateAssistantResultWindow(): BrowserWindow | null {
    const existing = this.options.getAssistantResultWindow?.() ?? null
    if (existing && !existing.isDestroyed()) {
      return existing
    }

    const created = createAssistantResultWindow()
    this.options.setAssistantResultWindow?.(created)
    return created
  }
}
