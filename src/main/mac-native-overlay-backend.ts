import { keyboardListener } from '../native-keyboard-listener'
import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'
import type { OverlayBackend } from './overlay-backend'

export class MacNativeOverlayBackend implements OverlayBackend {
  readonly id = 'native-mac'

  start(): boolean {
    // Don't start the process here - ShortcutService manages the lifecycle
    // Just check if it's running
    return keyboardListener.isRunning()
  }

  destroy(): void {
    // Don't stop the process here - ShortcutService manages the lifecycle
  }

  isAvailable(): boolean {
    return keyboardListener.isRunning()
  }

  showHud(payload: OverlayHudPayload): void {
    if (!this.isAvailable()) return
    keyboardListener.showOverlayHud(payload)
  }

  updateHud(payload: OverlayHudPayload): void {
    if (!this.isAvailable()) return
    keyboardListener.updateOverlayHud(payload)
  }

  hideHud(): void {
    if (!this.isAvailable()) return
    keyboardListener.hideOverlayHud()
  }

  showResult(payload: OverlayResultPayload): void {
    if (!this.isAvailable()) return
    keyboardListener.showOverlayResult(payload)
  }

  hideResult(): void {
    if (!this.isAvailable()) return
    keyboardListener.hideOverlayResult()
  }

  dismissAll(): void {
    if (!this.isAvailable()) return
    keyboardListener.dismissAllOverlays()
  }

  updatePipelineStatus(status: string): void {
    if (!this.isAvailable()) return
    keyboardListener.updateOverlayPipelineStatus(status)
  }
}
