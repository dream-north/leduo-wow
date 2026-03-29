import type { BrowserWindow } from 'electron'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'
import { ElectronOverlayBackend } from './electron-overlay-backend'
import { MacNativeOverlayBackend } from './mac-native-overlay-backend'

interface OverlayManagerOptions {
  overlayWindow: BrowserWindow | null
  getAssistantResultWindow?: () => BrowserWindow | null
  setAssistantResultWindow?: (window: BrowserWindow | null) => void
  platform?: NodeJS.Platform
  nativeBackend?: OverlayBackend
  fallbackBackend?: OverlayBackend
}

export class OverlayManager implements OverlayBackend {
  readonly id: string
  private nativeBackend?: OverlayBackend
  private fallbackBackend: OverlayBackend
  private _activeBackend: OverlayBackend

  constructor(options: OverlayManagerOptions) {
    const platform = options.platform ?? process.platform
    this.nativeBackend = options.nativeBackend ?? (platform === 'darwin' ? new MacNativeOverlayBackend() : undefined)
    this.fallbackBackend = options.fallbackBackend ?? new ElectronOverlayBackend({
      overlayWindow: options.overlayWindow,
      getAssistantResultWindow: options.getAssistantResultWindow,
      setAssistantResultWindow: options.setAssistantResultWindow
    })

    // Start with fallback, will switch to native when available
    this.fallbackBackend.start()
    this._activeBackend = this.fallbackBackend
    this.id = this._activeBackend.id
  }

  private get activeBackend(): OverlayBackend {
    // Check if native backend is now available (ShortcutService started it)
    if (this.nativeBackend?.isAvailable() && this._activeBackend !== this.nativeBackend) {
      this._activeBackend = this.nativeBackend
    }
    return this._activeBackend
  }

  start(): boolean {
    return this.activeBackend.isAvailable() || this.activeBackend.start()
  }

  destroy(): void {
    if (this.nativeBackend && this.nativeBackend !== this._activeBackend) {
      this.nativeBackend.destroy()
    }
    this._activeBackend.destroy()
  }

  isAvailable(): boolean {
    return this.activeBackend.isAvailable()
  }

  showHud(payload: OverlayHudPayload): void {
    this.activeBackend.showHud(payload)
  }

  updateHud(payload: OverlayHudPayload): void {
    this.activeBackend.updateHud(payload)
  }

  hideHud(): void {
    this.activeBackend.hideHud()
  }

  showResult(payload: OverlayResultPayload): void {
    this.activeBackend.showResult(payload)
  }

  hideResult(): void {
    this.activeBackend.hideResult()
    if (this._activeBackend !== this.fallbackBackend) {
      this.fallbackBackend.hideResult()
    }
  }

  dismissAll(): void {
    this.activeBackend.dismissAll()
    // Also dismiss Electron result window if native backend is active
    if (this._activeBackend !== this.fallbackBackend) {
      this.fallbackBackend.hideResult()
    }
  }

  updatePipelineStatus(status: string): void {
    this.activeBackend.updatePipelineStatus?.(status)
  }
}
