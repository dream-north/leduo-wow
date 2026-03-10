/**
 * Shortcut Manager - Swift Keyboard Listener Integration
 *
 * Uses Swift-based keyboard listener for shortcut detection:
 * - Single-key shortcuts (RightCommand, LeftOption, etc.)
 * - Combo shortcuts (Command+Space, LeftOption+1, etc.)
 * - Left/Right modifier key distinction
 *
 * The Swift process handles:
 * - Raw keyboard event capture via CGEventTap
 * - Shortcut matching when configured
 * - Emitting 'shortcut' events when a shortcut is triggered
 */

import { keyboardListener, KeyInfo } from '../native-keyboard-listener'
import { ConfigStore, getConfig } from './config-store'
import { Pipeline } from './pipeline'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { VoiceMode } from '../shared/types'

export class ShortcutManager {
  private configStore: ConfigStore
  private pipeline: Pipeline
  private settingsWindow: BrowserWindow | null = null
  private transcriptionShortcut: string = ''
  private assistantShortcut: string = ''
  private isRecording: boolean = false
  private recordingMode: VoiceMode | null = null
  private listenerActive: boolean = false
  private lastTriggerTime: number = 0
  private debounceMs: number = 300  // Debounce to prevent multiple triggers

  constructor(configStore: ConfigStore, pipeline: Pipeline) {
    this.configStore = configStore
    this.pipeline = pipeline
  }

  setSettingsWindow(window: BrowserWindow | null): void {
    this.settingsWindow = window
  }

  /**
   * Start the Swift keyboard listener
   */
  private startListener(): boolean {
    if (this.listenerActive) return true

    try {
      // Listen for shortcut events from Swift
      keyboardListener.onShortcut((shortcut: string, id?: string) => {
        // 使用 id 判断模式，如果没有 id 则回退到 shortcut 字符串匹配
        const mode = id || (shortcut === this.assistantShortcut ? 'assistant' : 'transcription')
        this.handleShortcutTriggered(mode as VoiceMode)
      })

      // Listen for key events
      keyboardListener.onKeyDown((info: KeyInfo) => {
        this.handleKeyDown(info)
        this.forwardKeyEventToRenderer('keydown', info)
      })

      keyboardListener.onKeyUp((info: KeyInfo) => {
        this.handleKeyUp(info)
        this.forwardKeyEventToRenderer('keyup', info)
      })

      const started = keyboardListener.start()
      if (started) {
        this.listenerActive = true
        console.log('[ShortcutManager] Swift keyboard listener started')
      }
      return started
    } catch (err) {
      console.error('[ShortcutManager] Failed to start listener:', err)
      return false
    }
  }

  /**
   * Forward keyboard events to renderer for shortcut recording
   */
  private forwardKeyEventToRenderer(type: 'keydown' | 'keyup', info: KeyInfo): void {
    if (!this.isRecording || !this.settingsWindow || this.settingsWindow.isDestroyed()) {
      return
    }

    this.settingsWindow.webContents.send(IPC.KEYBOARD_EVENT, {
      type,
      key: info.key,
      code: info.code,
      keyCode: info.keyCode,
      side: info.side,
      modifiers: info.modifiers,
      ctrlKey: info.modifiers.some(m => m.includes('Control')),
      altKey: info.modifiers.some(m => m.includes('Alt')),
      metaKey: info.modifiers.some(m => m.includes('Meta')),
      shiftKey: info.modifiers.some(m => m.includes('Shift'))
    })
  }

  /**
   * Stop the Swift keyboard listener
   */
  private stopListener(): void {
    if (!this.listenerActive) return

    try {
      keyboardListener.stop()
      this.listenerActive = false
      console.log('[ShortcutManager] Swift keyboard listener stopped')
    } catch (err) {
      console.error('[ShortcutManager] Failed to stop listener:', err)
    }
  }

  /**
   * Clean up resources (call on app quit)
   */
  destroy(): void {
    this.stopListener()
  }

  /**
   * Handle shortcut triggered from Swift
   */
  private handleShortcutTriggered(mode: VoiceMode): void {
    const now = Date.now()

    console.log(`[ShortcutManager] Shortcut triggered for mode: ${mode}`)

    // Debounce for shortcut trigger
    if (now - this.lastTriggerTime < this.debounceMs) {
      return
    }

    if (this.isRecording) return

    this.lastTriggerTime = now

    console.log(`[ShortcutManager] Triggering pipeline in ${mode} mode`)
    this.pipeline.toggle(mode)
  }

  /**
   * Handle key down from listener
   */
  private handleKeyDown(info: KeyInfo): void {
    // Check for ESC key during recording
    if (this.isRecording && (info.key === 'Escape' || info.code === 'Escape')) {
      this.pipeline.cancel()
    }
  }

  /**
   * Handle key up from listener
   */
  private handleKeyUp(_info: KeyInfo): void {
    // Key up handling - can be used for debugging if needed
  }

  /**
   * Register both shortcuts with the Swift listener
   */
  register(): boolean {
    const config = getConfig(this.configStore)
    this.transcriptionShortcut = config.transcriptionShortcut || 'RightCommand'
    this.assistantShortcut = config.assistantShortcut || 'RightOption'

    console.log(`[ShortcutManager] Registering shortcuts:`)
    console.log(`  - Transcription: ${this.transcriptionShortcut}`)
    console.log(`  - Assistant: ${this.assistantShortcut}`)

    // Start the listener first
    const started = this.startListener()
    if (!started) return false

    // Pass both shortcuts to Swift for matching
    keyboardListener.setShortcuts([
      { id: 'transcription', shortcut: this.transcriptionShortcut },
      { id: 'assistant', shortcut: this.assistantShortcut }
    ])

    return true
  }

  /**
   * Update a specific mode's shortcut
   */
  updateShortcut(mode: VoiceMode, shortcut: string): boolean {
    if (mode === 'transcription') {
      this.transcriptionShortcut = shortcut
    } else {
      this.assistantShortcut = shortcut
    }

    // Update Swift listener with new shortcuts
    keyboardListener.setShortcuts([
      { id: 'transcription', shortcut: this.transcriptionShortcut },
      { id: 'assistant', shortcut: this.assistantShortcut }
    ])

    return true
  }

  unregister(): void {
    this.transcriptionShortcut = ''
    this.assistantShortcut = ''
    // Clear shortcuts in Swift (will stop matching) but keep listener running
    keyboardListener.setShortcuts([])
    // Don't stop listener - keep it running for shortcut recording
  }

  /**
   * Temporarily unregister for recording
   */
  unregisterForRecording(mode: VoiceMode): void {
    this.isRecording = true
    this.recordingMode = mode
    // Clear shortcuts in Swift to stop trigger events during recording
    keyboardListener.setShortcuts([])
    // Keep Swift running to capture keyboard events for recording
  }

  /**
   * Re-register after recording
   */
  reRegisterAfterRecording(newShortcut?: string): boolean {
    // 先保存 recordingMode，因为下面要清空
    const mode = this.recordingMode

    this.isRecording = false
    this.recordingMode = null

    if (newShortcut && mode) {
      this.updateShortcut(mode, newShortcut)
    }

    // Re-register both shortcuts
    keyboardListener.setShortcuts([
      { id: 'transcription', shortcut: this.transcriptionShortcut },
      { id: 'assistant', shortcut: this.assistantShortcut }
    ])

    return true
  }

  getTranscriptionShortcut(): string {
    return this.transcriptionShortcut
  }

  getAssistantShortcut(): string {
    return this.assistantShortcut
  }
}