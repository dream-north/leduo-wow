import { EventEmitter } from 'events'
import { globalShortcut } from 'electron'
import { keyboardListener, KeyInfo, parseShortcut } from '../native-keyboard-listener'
import { ConfigStore, getConfig } from './config-store'
import { Pipeline } from './pipeline'
import { checkPermissions } from './permissions'
import type {
  ShortcutBackendState,
  ShortcutModeStatus,
  ShortcutServiceStatus,
  ShortcutStatusReason,
  VoiceMode
} from '../shared/types'

interface ShortcutRegistration {
  id: VoiceMode
  shortcut: string
}

interface ShortcutBackendCapabilities {
  global: boolean
  sideAware: boolean
  supportsModifierOnly: boolean
  requiresAccessibility: boolean
}

interface ShortcutBackend extends EventEmitter {
  id: ShortcutBackendState
  capabilities: ShortcutBackendCapabilities
  start(): boolean
  stop(): void
  setShortcuts(shortcuts: ShortcutRegistration[]): void
  isAvailable(): boolean
}

interface ShortcutStatusChangedEvent {
  status: ShortcutServiceStatus
}

const ESCAPE_KEYS = new Set(['Escape', 'Esc'])

function isValidShortcut(shortcut: string): boolean {
  const parsed = parseShortcut(shortcut)
  return parsed.modifiers.length > 0
}

function isFallbackCompatible(shortcut: string): boolean {
  const parsed = parseShortcut(shortcut)
  return parsed.side === 'any' && parsed.key !== null && parsed.modifiers.length > 0
}

function mapModifierToAccelerator(part: string): string | null {
  switch (part) {
    case 'Command':
    case 'Cmd':
    case 'Meta':
      return 'Command'
    case 'Control':
    case 'Ctrl':
      return 'Control'
    case 'Alt':
    case 'Option':
      return 'Alt'
    case 'Shift':
      return 'Shift'
    default:
      return null
  }
}

function mapKeyToAccelerator(part: string): string {
  const map: Record<string, string> = {
    Return: 'Enter',
    Space: 'Space',
    Up: 'Up',
    Down: 'Down',
    Left: 'Left',
    Right: 'Right',
    Escape: 'Esc',
    Delete: 'Delete',
    Backspace: 'Backspace',
    Tab: 'Tab'
  }
  return map[part] || part
}

function toElectronAccelerator(shortcut: string): string | null {
  const parts = shortcut.split('+').map((part) => part.trim()).filter(Boolean)
  if (parts.length < 2) return null

  const modifiers: string[] = []
  let key: string | null = null

  for (const part of parts) {
    if (part.startsWith('Left') || part.startsWith('Right')) {
      return null
    }

    const modifier = mapModifierToAccelerator(part)
    if (modifier) {
      if (!modifiers.includes(modifier)) {
        modifiers.push(modifier)
      }
      continue
    }

    key = mapKeyToAccelerator(part)
  }

  if (!key || modifiers.length === 0) return null
  return [...modifiers, key].join('+')
}

class MacNativeShortcutBackend extends EventEmitter implements ShortcutBackend {
  readonly id: ShortcutBackendState = 'native'
  readonly capabilities: ShortcutBackendCapabilities = {
    global: true,
    sideAware: true,
    supportsModifierOnly: true,
    requiresAccessibility: true
  }

  private started = false
  private shortcuts: ShortcutRegistration[] = []

  constructor() {
    super()

    keyboardListener.onShortcut((shortcut: string, id?: string) => {
      if (!this.started || !id) return
      this.emit('trigger', id as VoiceMode, shortcut)
    })

    keyboardListener.onKeyDown((info: KeyInfo) => {
      if (!this.started) return
      if (ESCAPE_KEYS.has(info.key) || ESCAPE_KEYS.has(info.code)) {
        this.emit('escape')
      }
    })

    keyboardListener.onExit((code) => {
      if (!this.started) return
      this.started = false
      this.emit('exit', code)
    })

    // Handle start error from Swift process (EventTap creation failed)
    keyboardListener.on('start-error', () => {
      console.warn('[MacNativeShortcutBackend] Swift EventTap creation failed')
      if (this.started) {
        this.started = false
        this.emit('exit', null)
      }
    })
  }

  start(): boolean {
    // If already started and event tap is ready, just return
    if (this.started && keyboardListener.isReady()) {
      return true
    }

    // If started but event tap not ready, return false (caller should decide whether to restart)
    if (this.started) {
      console.log('[MacNativeShortcutBackend] Started but event tap not ready')
      return false
    }

    // Not started yet, start fresh
    const started = keyboardListener.start()
    if (started) {
      this.started = true
      this.applyShortcuts()
    }
    return started
  }

  restart(): boolean {
    if (!this.started) {
      return this.start()
    }

    const restarted = keyboardListener.restart()
    this.started = restarted
    if (restarted) {
      this.applyShortcuts()
    }
    return restarted
  }

  forceRestart(): boolean {
    console.log('[MacNativeShortcutBackend] Force restarting...')
    const restarted = keyboardListener.forceRestart()
    this.started = restarted
    if (restarted) {
      this.applyShortcuts()
    }
    return restarted
  }

  stop(): void {
    if (!this.started) return
    this.started = false
    if (keyboardListener.isRunning()) {
      keyboardListener.setShortcuts([])
      keyboardListener.stop()
    }
  }

  setShortcuts(shortcuts: ShortcutRegistration[]): void {
    this.shortcuts = shortcuts
    this.applyShortcuts()
  }

  isAvailable(): boolean {
    return this.started && keyboardListener.isReady()
  }

  private applyShortcuts(): void {
    if (!this.started) return
    keyboardListener.setShortcuts(this.shortcuts.map((shortcut) => ({
      id: shortcut.id,
      shortcut: shortcut.shortcut
    })))
  }
}

class GlobalShortcutFallbackBackend extends EventEmitter implements ShortcutBackend {
  readonly id: ShortcutBackendState = 'fallback'
  readonly capabilities: ShortcutBackendCapabilities = {
    global: true,
    sideAware: false,
    supportsModifierOnly: false,
    requiresAccessibility: false
  }

  private started = false
  private shortcuts: ShortcutRegistration[] = []
  private registeredAccelerators: string[] = []
  private registeredModes = new Set<VoiceMode>()

  start(): boolean {
    this.started = true
    this.applyShortcuts()
    return true
  }

  stop(): void {
    this.unregisterAll()
    this.started = false
  }

  setShortcuts(shortcuts: ShortcutRegistration[]): void {
    this.shortcuts = shortcuts
    this.applyShortcuts()
  }

  isAvailable(): boolean {
    return this.started
  }

  getRegisteredModes(): Set<VoiceMode> {
    return new Set(this.registeredModes)
  }

  private unregisterAll(): void {
    for (const accelerator of this.registeredAccelerators) {
      globalShortcut.unregister(accelerator)
    }
    this.registeredAccelerators = []
    this.registeredModes.clear()
  }

  private applyShortcuts(): void {
    this.unregisterAll()
    if (!this.started) return

    for (const shortcut of this.shortcuts) {
      const accelerator = toElectronAccelerator(shortcut.shortcut)
      if (!accelerator) continue

      const registered = globalShortcut.register(accelerator, () => {
        this.emit('trigger', shortcut.id, shortcut.shortcut)
      })

      if (registered) {
        this.registeredAccelerators.push(accelerator)
        this.registeredModes.add(shortcut.id)
      } else {
        this.emit('register-failed', shortcut)
      }
    }
  }
}

export class ShortcutService extends EventEmitter {
  private configStore: ConfigStore
  private pipeline: Pipeline
  private nativeBackend = new MacNativeShortcutBackend()
  private fallbackBackend = new GlobalShortcutFallbackBackend()
  private status: ShortcutServiceStatus = this.buildEmptyStatus()
  private lastTriggerTime = 0
  private readonly debounceMs = 300
  private accessibilityPollTimer: ReturnType<typeof setInterval> | null = null
  private accessibilityPollAttempts = 0
  private wasAccessibilityGranted = false
  private nativeBackendReady = false  // Set by ensureNativeBackendReady()

  constructor(configStore: ConfigStore, pipeline: Pipeline) {
    super()
    this.configStore = configStore
    this.pipeline = pipeline

    this.nativeBackend.on('trigger', (mode: VoiceMode) => this.handleShortcutTriggered(mode))
    this.nativeBackend.on('escape', () => this.pipeline.cancel())
    this.nativeBackend.on('exit', () => {
      console.warn('[ShortcutService] Native backend exited unexpectedly')
      this.nativeBackendReady = false
      this.refresh()
    })

    this.fallbackBackend.on('trigger', (mode: VoiceMode) => this.handleShortcutTriggered(mode))
  }

  start(): void {
    this.wasAccessibilityGranted = checkPermissions().accessibility
    this.refresh()
  }

  destroy(): void {
    this.stopAccessibilityPolling()
    this.nativeBackendReady = false
    this.nativeBackend.stop()
    this.fallbackBackend.stop()
  }

  refresh(): ShortcutServiceStatus {
    const config = getConfig(this.configStore)
    const permissions = checkPermissions()
    const hasAccessibility = permissions.accessibility
    this.wasAccessibilityGranted = hasAccessibility

    const shortcuts: ShortcutRegistration[] = [
      { id: 'transcription', shortcut: config.transcriptionShortcut || 'RightCommand' },
      { id: 'assistant', shortcut: config.assistantShortcut || 'RightOption' }
    ]

    let backendState: ShortcutBackendState = 'disabled'
    let reason: ShortcutStatusReason = hasAccessibility ? 'backend_failed' : 'permission_missing'
    let registeredFallbackModes = new Set<VoiceMode>()

    if (hasAccessibility) {
      this.stopAccessibilityPolling()
      this.fallbackBackend.stop()

      // If native backend was already confirmed ready, just update shortcuts
      if (this.nativeBackendReady && this.nativeBackend.isAvailable()) {
        this.nativeBackend.setShortcuts(shortcuts.filter((shortcut) => isValidShortcut(shortcut.shortcut)))
        backendState = 'native'
        reason = 'ready'
      } else {
        // Native backend not ready yet - don't start here, let ensureNativeBackendReady handle it
        // Just use fallback for now
        const fallbackShortcuts = shortcuts.filter((shortcut) => isFallbackCompatible(shortcut.shortcut))
        if (fallbackShortcuts.length > 0) {
          this.fallbackBackend.start()
          this.fallbackBackend.setShortcuts(fallbackShortcuts)
          registeredFallbackModes = this.fallbackBackend.getRegisteredModes()
          if (registeredFallbackModes.size > 0) {
            backendState = 'fallback'
            reason = 'ready'
          } else {
            reason = 'backend_failed'
          }
        }
      }
    } else {
      // No accessibility permission - ensure native backend is stopped
      this.nativeBackendReady = false
      this.nativeBackend.stop()
      this.stopAccessibilityPolling()

      const fallbackShortcuts = shortcuts.filter((shortcut) => isFallbackCompatible(shortcut.shortcut))
      if (fallbackShortcuts.length > 0) {
        this.fallbackBackend.start()
        this.fallbackBackend.setShortcuts(fallbackShortcuts)
        registeredFallbackModes = this.fallbackBackend.getRegisteredModes()
        if (registeredFallbackModes.size > 0) {
          backendState = 'fallback'
          reason = 'ready'
        } else {
          reason = 'backend_failed'
        }
      } else {
        this.fallbackBackend.stop()
      }
    }

    const modes = shortcuts.reduce<Record<VoiceMode, ShortcutModeStatus>>((result, shortcut) => {
      const valid = isValidShortcut(shortcut.shortcut)
      const fallbackCompatible = isFallbackCompatible(shortcut.shortcut)

      let modeBackendState: ShortcutBackendState = 'disabled'
      let modeReason: ShortcutStatusReason = 'backend_failed'
      let requiresAccessibility = false
      let canTriggerGlobally = false

      if (valid && hasAccessibility && backendState === 'native') {
        modeBackendState = 'native'
        modeReason = 'ready'
        requiresAccessibility = true
        canTriggerGlobally = true
      } else if (valid && fallbackCompatible && backendState === 'fallback' && registeredFallbackModes.has(shortcut.id)) {
        modeBackendState = 'fallback'
        modeReason = 'ready'
        requiresAccessibility = false
        canTriggerGlobally = true
      } else if (valid && !fallbackCompatible && !hasAccessibility) {
        modeBackendState = 'disabled'
        modeReason = 'unsupported_without_accessibility'
        requiresAccessibility = true
      } else if (valid && fallbackCompatible && backendState !== 'fallback') {
        modeBackendState = 'disabled'
        modeReason = 'backend_failed'
      } else if (valid && hasAccessibility) {
        modeBackendState = 'disabled'
        modeReason = 'backend_failed'
        requiresAccessibility = true
      } else {
        modeBackendState = 'disabled'
        modeReason = hasAccessibility ? 'backend_failed' : 'permission_missing'
      }

      result[shortcut.id] = {
        mode: shortcut.id,
        shortcut: shortcut.shortcut,
        backendState: modeBackendState,
        reason: modeReason,
        requiresAccessibility,
        canTriggerGlobally
      }
      return result
    }, {} as Record<VoiceMode, ShortcutModeStatus>)

    this.status = {
      permissionState: hasAccessibility ? 'granted' : 'missing',
      backendState,
      reason,
      modes
    }

    this.emit('status-changed', { status: this.status } satisfies ShortcutStatusChangedEvent)
    return this.status
  }

  getStatus(): ShortcutServiceStatus {
    return this.status
  }

  updateShortcut(_mode: VoiceMode, _shortcut: string): ShortcutServiceStatus {
    return this.refresh()
  }

  beginAccessibilityPolling(): void {
    if (this.status.permissionState === 'granted' || this.accessibilityPollTimer) return

    this.accessibilityPollAttempts = 0
    this.accessibilityPollTimer = setInterval(() => {
      this.accessibilityPollAttempts += 1
      const status = this.refresh()
      if (status.permissionState === 'granted' || this.accessibilityPollAttempts >= 20) {
        this.stopAccessibilityPolling()
      }
    }, 1000)
  }

  private stopAccessibilityPolling(): void {
    if (this.accessibilityPollTimer) {
      clearInterval(this.accessibilityPollTimer)
      this.accessibilityPollTimer = null
    }
    this.accessibilityPollAttempts = 0
  }

  /**
   * Ensure native backend is ready. This will retry starting the native backend
   * until it succeeds or max attempts are reached.
   * Returns true if native backend is ready, false otherwise.
   */
  async ensureNativeBackendReady(maxAttempts = 15, delayMs = 300): Promise<boolean> {
    const permissions = checkPermissions()
    if (!permissions.accessibility) {
      return false
    }

    // Force restart to ensure clean state (kills any existing process)
    this.nativeBackendReady = false

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      console.log(`[ShortcutService] Attempt ${attempt + 1}/${maxAttempts}: Force restarting native backend...`)

      // Force restart to ensure only one process
      this.nativeBackend.forceRestart()

      // Wait for Swift process to respond
      await new Promise(resolve => setTimeout(resolve, delayMs))

      // Check if the event tap is actually ready
      if (this.nativeBackend.isAvailable()) {
        // Apply shortcuts
        const config = getConfig(this.configStore)
        const shortcuts: ShortcutRegistration[] = [
          { id: 'transcription', shortcut: config.transcriptionShortcut || 'RightCommand' },
          { id: 'assistant', shortcut: config.assistantShortcut || 'RightOption' }
        ]
        this.nativeBackend.setShortcuts(shortcuts.filter((shortcut) => isValidShortcut(shortcut.shortcut)))

        // Mark as ready so subsequent refresh() won't stop it
        this.nativeBackendReady = true

        // Update status
        this.refresh()
        console.log('[ShortcutService] Native backend ready!')
        return true
      }

      // Event tap not ready, will retry with forceRestart
      console.log('[ShortcutService] Event tap not ready, retrying...')
    }

    console.warn('[ShortcutService] Native backend failed to start after all attempts')
    return false
  }

  private handleShortcutTriggered(mode: VoiceMode): void {
    const now = Date.now()
    if (now - this.lastTriggerTime < this.debounceMs) return

    this.lastTriggerTime = now
    void this.pipeline.toggle(mode)
  }

  private buildEmptyStatus(): ShortcutServiceStatus {
    return {
      permissionState: 'missing',
      backendState: 'disabled',
      reason: 'permission_missing',
      modes: {
        transcription: {
          mode: 'transcription',
          shortcut: 'RightCommand',
          backendState: 'disabled',
          reason: 'permission_missing',
          requiresAccessibility: true,
          canTriggerGlobally: false
        },
        assistant: {
          mode: 'assistant',
          shortcut: 'RightOption',
          backendState: 'disabled',
          reason: 'permission_missing',
          requiresAccessibility: true,
          canTriggerGlobally: false
        }
      }
    }
  }
}
