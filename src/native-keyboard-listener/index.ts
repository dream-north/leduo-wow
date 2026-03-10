/**
 * Native Keyboard Listener - Swift Process Implementation
 *
 * Provides keyboard event monitoring via a Swift subprocess.
 * The Swift process uses CGEventTap to capture keyboard events
 * and communicates via JSON over stdin/stdout.
 *
 * This module provides:
 * - Single-key shortcut detection (RightCommand, RightOption, etc.)
 * - Traditional combo shortcut support
 * - Left/Right modifier key distinction
 *
 * Usage:
 *   import { keyboardListener } from './native-keyboard-listener'
 *
 *   keyboardListener.start()
 *   keyboardListener.onKeyDown((info) => { ... })
 */

import { EventEmitter } from 'events'
import { spawn, ChildProcess } from 'child_process'
import path from 'path'

export interface KeyInfo {
  key: string      // Key name: "MetaLeft", "MetaRight", "AltLeft", etc.
  code: string     // e.code value
  keyCode: number  // Raw keycode
  side: 'left' | 'right' | 'unknown'
  modifiers: string[]  // Current held modifiers: ["MetaLeft", "ShiftRight"]
  timestamp: number
}

export type KeyEventHandler = (info: KeyInfo) => void

// Current state tracking
let currentModifiers: Set<string> = new Set()
let currentKeys: Set<string> = new Set()

class SwiftKeyboardListener extends EventEmitter {
  private process: ChildProcess | null = null
  private running: boolean = false
  private buffer: string = ''

  /**
   * Start the Swift keyboard listener process
   */
  start(): boolean {
    if (this.running) return true

    // Find the Swift executable
    let executablePath: string

    if (process.env.NODE_ENV === 'production' || __dirname.includes('app.asar')) {
      // Running from packaged app - use extraResources
      executablePath = path.join(process.resourcesPath, 'SwiftKeyboardListener')
    } else if (__dirname.includes('out/main')) {
      // Running from compiled output - navigate to source directory
      executablePath = path.join(__dirname, '..', '..', 'src', 'native-keyboard-listener', 'SwiftKeyboardListener', 'build', 'SwiftKeyboardListener')
    } else {
      // Running from source
      executablePath = path.join(__dirname, 'SwiftKeyboardListener', 'build', 'SwiftKeyboardListener')
    }

    console.log('[SwiftKeyboardListener] Executable path:', executablePath)

    // 检查文件是否存在
    const fs = require('fs')
    if (!fs.existsSync(executablePath)) {
      console.error('[SwiftKeyboardListener] Executable not found:', executablePath)
      return false
    }

    // 检查文件权限
    try {
      const stats = fs.statSync(executablePath)
      console.log('[SwiftKeyboardListener] File permissions:', stats.mode.toString(8))
      console.log('[SwiftKeyboardListener] File size:', stats.size, 'bytes')
    } catch (e) {
      console.error('[SwiftKeyboardListener] Failed to stat file:', e)
    }

    try {
      this.process = spawn(executablePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: false
      })

      if (!this.process || !this.process.stdout || !this.process.stdin) {
        console.error('[SwiftKeyboardListener] Failed to spawn process')
        return false
      }

      this.process.on('error', (err) => {
        console.error('[SwiftKeyboardListener] Process error:', err)
        this.running = false
      })

      this.process.on('exit', (code) => {
        console.log('[SwiftKeyboardListener] Process exited with code:', code)
        this.running = false
      })

      // Handle stdout data
      this.process.stdout.on('data', (data: Buffer) => {
        this.handleData(data)
      })

      // Handle stderr
      this.process.stderr?.on('data', (data: Buffer) => {
        console.error('[SwiftKeyboardListener] stderr:', data.toString())
      })

      // Send start command
      this.sendCommand({ command: 'start' })

      this.running = true
      console.log('[SwiftKeyboardListener] Started Swift process')

      return true
    } catch (err) {
      console.error('[SwiftKeyboardListener] Failed to start:', err)
      return false
    }
  }

  /**
   * Stop the Swift keyboard listener
   */
  stop(): void {
    if (!this.running) return

    try {
      this.sendCommand({ command: 'stop' })

      if (this.process) {
        this.process.stdin?.end()
        this.process.kill()
        this.process = null
      }

      currentModifiers.clear()
      currentKeys.clear()
      this.running = false
      console.log('[SwiftKeyboardListener] Stopped')
    } catch (err) {
      console.error('[SwiftKeyboardListener] Failed to stop:', err)
    }
  }

  /**
   * Set the shortcut to match (for trigger detection) - 兼容旧版单快捷键
   */
  setShortcut(shortcut: string): void {
    this.sendCommand({ command: 'setShortcut', shortcut })
  }

  /**
   * Set multiple shortcuts to match (for dual-mode support)
   * @param shortcuts Array of {id, shortcut} objects
   */
  setShortcuts(shortcuts: { id: string; shortcut: string }[]): void {
    this.sendCommand({ command: 'setShortcuts', shortcuts })
  }

  /**
   * Send command to Swift process
   */
  private sendCommand(cmd: Record<string, unknown>): void {
    if (this.process?.stdin) {
      this.process.stdin.write(JSON.stringify(cmd) + '\n')
    }
  }

  /**
   * Handle incoming data from Swift
   */
  private handleData(data: Buffer): void {
    this.buffer += data.toString()

    // Process complete lines
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() || '' // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue

      try {
        const event = JSON.parse(line)
        this.processEvent(event)
      } catch (err) {
        // Ignore parse errors for incomplete lines
      }
    }
  }

  /**
   * Process parsed event from Swift
   */
  private processEvent(event: Record<string, unknown>): void {
    const type = event.type as string

    if (type === 'keydown') {
      const info = this.convertKeyEvent(event)
      currentKeys.add(info.key)
      this.emit('keydown', info)
    } else if (type === 'keyup') {
      const info = this.convertKeyEvent(event)
      currentKeys.delete(info.key)
      this.emit('keyup', info)
    } else if (type === 'shortcut') {
      // Shortcut triggered - emit special event
      this.emit('shortcut', event)
    }
  }

  /**
   * Convert Swift event to KeyInfo format
   */
  private convertKeyEvent(event: Record<string, unknown>): KeyInfo {
    const keyName = (event.key as string) || 'Unknown'
    const side = (event.side as 'left' | 'right' | 'unknown') || 'unknown'
    const modifiers = (event.modifiers as string[]) || []

    return {
      key: keyName,
      code: keyName,
      keyCode: (event.keyCode as number) || 0,
      side,
      modifiers,
      timestamp: (event.timestamp as number) || Date.now()
    }
  }

  /**
   * Register keydown event handler
   */
  onKeyDown(handler: KeyEventHandler): void {
    this.on('keydown', handler)
  }

  /**
   * Register keyup event handler
   */
  onKeyUp(handler: KeyEventHandler): void {
    this.on('keyup', handler)
  }

  /**
   * Register shortcut event handler
   * 事件包含 shortcut (快捷键字符串) 和 id (快捷键标识)
   */
  onShortcut(handler: (shortcut: string, id?: string) => void): void {
    this.on('shortcut', (event: Record<string, unknown>) => {
      handler(event.shortcut as string, event.id as string | undefined)
    })
  }

  /**
   * Remove keydown event handler
   */
  offKeyDown(handler: KeyEventHandler): void {
    this.off('keydown', handler)
  }

  /**
   * Remove keyup event handler
   */
  offKeyUp(handler: KeyEventHandler): void {
    this.off('keyup', handler)
  }

  /**
   * Get current pressed modifier keys
   */
  getModifiers(): string[] {
    return Array.from(currentModifiers)
  }

  /**
   * Get current pressed keys
   */
  getCurrentKeys(): string[] {
    return Array.from(currentKeys)
  }

  /**
   * Check if listener is running
   */
  isRunning(): boolean {
    return this.running
  }
}

export const keyboardListener = new SwiftKeyboardListener()

/**
 * Parse a shortcut string into components
 *
 * @example
 * parseShortcut("RightCommand")     // { side: 'right', modifiers: ['Meta'], key: null }
 * parseShortcut("Command+Space")     // { side: 'any', modifiers: ['Meta'], key: 'Space' }
 * parseShortcut("LeftOption+A")      // { side: 'left', modifiers: ['Alt'], key: 'A' }
 */
export function parseShortcut(shortcut: string): {
  side: 'left' | 'right' | 'any'
  modifiers: string[]
  key: string | null
} {
  const parts = shortcut.split('+')
  const result: {
    side: 'left' | 'right' | 'any'
    modifiers: string[]
    key: string | null
  } = {
    side: 'any',
    modifiers: [],
    key: null
  }

  for (const part of parts) {
    const normalized = part.trim()

    // Check for side-specific modifiers
    if (normalized.startsWith('Left')) {
      result.side = 'left'
      const modifier = normalized.replace('Left', '')
      result.modifiers.push(mapModifierName(modifier))
    } else if (normalized.startsWith('Right')) {
      result.side = 'right'
      const modifier = normalized.replace('Right', '')
      result.modifiers.push(mapModifierName(modifier))
    } else if (isModifierKey(normalized)) {
      result.modifiers.push(mapModifierName(normalized))
    } else {
      // This is the main key
      result.key = normalized
    }
  }

  return result
}

function isModifierKey(key: string): boolean {
  const modifiers = ['Command', 'Control', 'Alt', 'Shift', 'Ctrl', 'Meta', 'Option']
  return modifiers.includes(key)
}

function mapModifierName(name: string): string {
  const map: Record<string, string> = {
    'Command': 'Meta',
    'Ctrl': 'Control',
    'Option': 'Alt'
  }
  return map[name] || name
}

/**
 * Match current key state against a shortcut configuration
 */
export function matchShortcut(
  currentModifiers: string[],
  currentKeys: string[],
  config: ReturnType<typeof parseShortcut>,
  lastKeyDownKey?: string | null
): boolean {
  console.log('[matchShortcut] config:', config, 'currentModifiers:', currentModifiers, 'currentKeys:', currentKeys, 'lastKeyDownKey:', lastKeyDownKey)

  // Check if single key (modifier-only shortcut, like "RightCommand")
  if (!config.key) {
    console.log('[matchShortcut] Modifier-only shortcut')
    // This is a modifier-only shortcut
    if (config.modifiers.length > 0) {
      // All required modifiers must be pressed
      const hasAllModifiers = config.modifiers.every(m => currentModifiers.includes(m))
      if (!hasAllModifiers) {
        console.log('[matchShortcut] Missing required modifiers')
        return false
      }

      // If side is specified, check that the correct side key was the last key pressed
      // and NO other non-modifier keys are pressed
      if (config.side !== 'any') {
        const sideKey = config.modifiers[0] + config.side.charAt(0).toUpperCase() + config.side.slice(1)
        console.log('[matchShortcut] Checking for side key:', sideKey, 'lastKeyDownKey:', lastKeyDownKey)

        // The last key pressed must be the side-specific modifier
        if (lastKeyDownKey !== sideKey) {
          console.log('[matchShortcut] Last key down does not match side key')
          return false
        }

        // Must NOT have any non-modifier keys pressed
        const nonModifierKeys = currentKeys.filter(k => {
          if (['Meta', 'Control', 'Alt', 'Shift'].includes(k)) return false
          if (k.endsWith('Left') || k.endsWith('Right')) return false
          return true
        })
        console.log('[matchShortcut] nonModifierKeys:', nonModifierKeys)
        if (nonModifierKeys.length > 0) {
          console.log('[matchShortcut] Extra non-modifier keys pressed')
          return false
        }

        console.log('[matchShortcut] Modifier-only shortcut matched')
        return true
      }

      return true
    }
    return false
  }

  // Combo shortcut (like "LeftOption+1")
  console.log('[matchShortcut] Combo shortcut')

  // The last key pressed should be the non-modifier key
  if (!lastKeyDownKey || lastKeyDownKey === config.modifiers[0]) {
    console.log('[matchShortcut] Last key is not the main key')
    return false
  }

  // Must have the main key pressed (could be the last key or already held)
  if (!currentKeys.includes(config.key) && lastKeyDownKey !== config.key) {
    console.log('[matchShortcut] Main key not found')
    return false
  }

  // Must have all required modifiers pressed
  for (const required of config.modifiers) {
    if (!currentModifiers.includes(required)) {
      console.log('[matchShortcut] Missing modifier:', required)
      return false
    }
  }

  // If side is specified for modifiers, verify the correct side is pressed
  if (config.side !== 'any') {
    for (const modifier of config.modifiers) {
      const expectedSideKey = modifier + config.side.charAt(0).toUpperCase() + config.side.slice(1)
      if (!currentKeys.includes(expectedSideKey)) {
        console.log('[matchShortcut] Side key not found:', expectedSideKey)
        return false
      }
    }
  }

  console.log('[matchShortcut] Combo shortcut matched')
  return true
}