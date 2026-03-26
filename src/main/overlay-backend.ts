import type { OverlayHudPayload, OverlayResultPayload } from '../shared/types'

export interface OverlayBackend {
  readonly id: string
  start(): boolean
  destroy(): void
  isAvailable(): boolean
  showHud(payload: OverlayHudPayload): void
  updateHud(payload: OverlayHudPayload): void
  hideHud(): void
  showResult(payload: OverlayResultPayload): void
  hideResult(): void
  dismissAll(): void
  updatePipelineStatus?(status: string): void
}
