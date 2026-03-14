import { keyboardListener } from '../native-keyboard-listener'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'

export class MacNativeOverlayBackend implements OverlayBackend {
  readonly id = 'native-mac'
  private active = false

  start(): boolean {
    this.active = keyboardListener.start()
    return this.active
  }

  destroy(): void {
    this.dismissAll()
    if (this.active) {
      keyboardListener.stop()
    }
    this.active = false
  }

  isAvailable(): boolean {
    return this.active && keyboardListener.isRunning()
  }

  showHud(payload: OverlayHudPayload): void {
    if (!this.ensureActive()) return
    keyboardListener.showOverlayHud(payload)
  }

  updateHud(payload: OverlayHudPayload): void {
    if (!this.ensureActive()) return
    keyboardListener.updateOverlayHud(payload)
  }

  hideHud(): void {
    if (!this.ensureActive()) return
    keyboardListener.hideOverlayHud()
  }

  showResult(payload: OverlayResultPayload): void {
    if (!this.ensureActive()) return
    keyboardListener.showOverlayResult(payload)
  }

  hideResult(): void {
    if (!this.ensureActive()) return
    keyboardListener.hideOverlayResult()
  }

  dismissAll(): void {
    if (!this.ensureActive()) return
    keyboardListener.dismissAllOverlays()
  }

  private ensureActive(): boolean {
    if (this.isAvailable()) return true
    this.active = keyboardListener.start()
    return this.active
  }
}
