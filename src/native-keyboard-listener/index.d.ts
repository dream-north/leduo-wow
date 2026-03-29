export interface KeyInfo {
  key: string
  code: string
  keyCode: number
  side: 'left' | 'right' | 'unknown'
  modifiers: string[]
  timestamp: number
}

export type KeyEventHandler = (info: KeyInfo) => void
export interface OverlayHudPayload {
  text: string
  mode: 'recording' | 'processing' | 'success' | 'error'
  voiceMode: 'transcription' | 'assistant' | 'screen_doc'
  screenshotActive: boolean
}

export interface OverlayResultPayload {
  text: string
  format: 'markdown'
  position?: OverlayWindowPosition
  size?: OverlayWindowSize
}

export interface OverlayWindowPosition {
  x: number
  y: number
}

export interface OverlayWindowSize {
  width: number
  height: number
}

class SwiftKeyboardListener {
  start(): boolean
  stop(): void
  setShortcut(shortcut: string): void
  setShortcuts(shortcuts: { id: string; shortcut: string }[]): void
  showOverlayHud(payload: OverlayHudPayload): void
  updateOverlayHud(payload: OverlayHudPayload): void
  hideOverlayHud(): void
  showOverlayResult(payload: OverlayResultPayload): void
  hideOverlayResult(): void
  dismissAllOverlays(): void
  onKeyDown(handler: KeyEventHandler): void
  onKeyUp(handler: KeyEventHandler): void
  onShortcut(handler: (shortcut: string, id?: string) => void): void
  onExit(handler: (code: number | null) => void): void
  onOverlayReady(handler: () => void): void
  onOverlayError(handler: (message: string) => void): void
  onOverlayResultClosed(handler: (position?: OverlayWindowPosition, size?: OverlayWindowSize) => void): void
  offKeyDown(handler: KeyEventHandler): void
  offKeyUp(handler: KeyEventHandler): void
  getModifiers(): string[]
  getCurrentKeys(): string[]
  isRunning(): boolean
  isReady(): boolean
  on(event: 'start-success' | 'start-error', handler: () => void): void
  on(event: string, handler: (...args: unknown[]) => void): void
}

export const keyboardListener: SwiftKeyboardListener

export function parseShortcut(shortcut: string): {
  side: 'left' | 'right' | 'any'
  modifiers: string[]
  key: string | null
}

export function matchShortcut(
  currentModifiers: string[],
  currentKeys: string[],
  config: ReturnType<typeof parseShortcut>,
  lastKeyDownKey?: string | null
): boolean
