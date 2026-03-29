import type { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'
import { parkOverlayWindow, positionOverlayAtCursor } from './overlay-window'
import { applyFloatingWindowBehavior } from './floating-window'
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
    applyFloatingWindowBehavior(overlayWindow, 'screen-saver', {
      windowsLevel: 'screen-saver'
    })
    overlayWindow.showInactive()
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
    showAssistantResultWindow(assistantResultWindow, {
      text: payload.text,
      resultKind: payload.resultKind,
      title: payload.title,
      eyebrow: payload.eyebrow,
      exportArtifactId: payload.exportArtifactId,
      position: payload.position,
      size: payload.size,
      detailsMarkdown: payload.detailsMarkdown,
      stats: payload.stats,
      sources: payload.sources,
      reasoningMarkdown: payload.reasoningMarkdown,
      reasoningCollapsed: payload.reasoningCollapsed,
      codeMarkdown: payload.codeMarkdown,
      codeCollapsed: payload.codeCollapsed,
      turnIndex: payload.turnIndex,
      userMessage: payload.userMessage,
      isConversation: payload.isConversation
    })
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

  updatePipelineStatus(_status: string): void {
    /* noop - Electron result window receives status via IPC broadcast */
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
