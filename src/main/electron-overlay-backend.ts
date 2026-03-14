import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'
import { positionOverlayAtCursor } from './overlay-window'
import { hideAssistantResultWindow, showAssistantResultWindow } from './assistant-result-window'

interface ElectronOverlayBackendOptions {
  overlayWindow: BrowserWindow | null
  assistantResultWindow: BrowserWindow | null
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
    const { overlayWindow, assistantResultWindow } = this.options
    return !!overlayWindow && !overlayWindow.isDestroyed() && !!assistantResultWindow && !assistantResultWindow.isDestroyed()
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
    overlayWindow.webContents.send(IPC.OVERLAY_UPDATE, {
      text: '',
      mode: 'recording',
      voiceMode: 'transcription',
      screenshotActive: false
    })
  }

  showResult(payload: OverlayResultPayload): void {
    const { assistantResultWindow } = this.options
    if (!assistantResultWindow || assistantResultWindow.isDestroyed()) return
    showAssistantResultWindow(assistantResultWindow, payload.text)
  }

  hideResult(): void {
    const { assistantResultWindow } = this.options
    if (!assistantResultWindow || assistantResultWindow.isDestroyed()) return
    hideAssistantResultWindow(assistantResultWindow)
  }

  dismissAll(): void {
    this.hideHud()
    this.hideResult()
  }
}
