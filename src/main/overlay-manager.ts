import type { BrowserWindow } from 'electron'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'
import { ElectronOverlayBackend } from './electron-overlay-backend'
import { MacNativeOverlayBackend } from './mac-native-overlay-backend'

interface OverlayManagerOptions {
  overlayWindow: BrowserWindow | null
  assistantResultWindow: BrowserWindow | null
  platform?: NodeJS.Platform
  nativeBackend?: OverlayBackend
  fallbackBackend?: OverlayBackend
}

export class OverlayManager implements OverlayBackend {
  readonly id: string
  private readonly activeBackend: OverlayBackend
  private readonly nativeBackend?: OverlayBackend
  private readonly fallbackBackend: OverlayBackend

  constructor(options: OverlayManagerOptions) {
    const platform = options.platform ?? process.platform
    this.nativeBackend = options.nativeBackend ?? (platform === 'darwin' ? new MacNativeOverlayBackend() : undefined)
    this.fallbackBackend = options.fallbackBackend ?? new ElectronOverlayBackend({
      overlayWindow: options.overlayWindow,
      assistantResultWindow: options.assistantResultWindow
    })

    const nativeReady = this.nativeBackend?.start() ?? false
    this.activeBackend = nativeReady ? this.nativeBackend! : this.fallbackBackend
    if (!nativeReady) {
      this.fallbackBackend.start()
    }
    this.id = this.activeBackend.id
  }

  start(): boolean {
    return this.activeBackend.isAvailable() || this.activeBackend.start()
  }

  destroy(): void {
    if (this.nativeBackend && this.nativeBackend !== this.activeBackend) {
      this.nativeBackend.destroy()
    }
    this.activeBackend.destroy()
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
  }

  dismissAll(): void {
    this.activeBackend.dismissAll()
  }
}
