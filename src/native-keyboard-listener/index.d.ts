export interface KeyInfo {
  key: string
  code: string
  keyCode: number
  side: 'left' | 'right' | 'unknown'
  modifiers: string[]
  timestamp: number
}

export type KeyEventHandler = (info: KeyInfo) => void

class SwiftKeyboardListener {
  start(): boolean
  stop(): void
  setShortcut(shortcut: string): void
  setShortcuts(shortcuts: { id: string; shortcut: string }[]): void
  onKeyDown(handler: KeyEventHandler): void
  onKeyUp(handler: KeyEventHandler): void
  onShortcut(handler: (shortcut: string, id?: string) => void): void
  onExit(handler: (code: number | null) => void): void
  offKeyDown(handler: KeyEventHandler): void
  offKeyUp(handler: KeyEventHandler): void
  getModifiers(): string[]
  getCurrentKeys(): string[]
  isRunning(): boolean
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
