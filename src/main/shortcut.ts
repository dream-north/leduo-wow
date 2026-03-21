import { EventEmitter } from 'events'
import { existsSync, readdirSync, statSync } from 'fs'
import { globalShortcut } from 'electron'
import { join } from 'path'
import { keyboardListener, KeyInfo, matchShortcut, parseShortcut } from '../native-keyboard-listener'
import { WindowsGlobalKeyboardListener } from './windows-global-key-listener'
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
import { getDefaultAssistantShortcut, getDefaultTranscriptionShortcut } from '../shared/types'

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

type ParsedShortcut = ReturnType<typeof parseShortcut>

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

function resolveBundledWindowsKeyServerPath(): string {
  if (process.env.NODE_ENV === 'production' || __dirname.includes('app.asar')) {
    return join(process.resourcesPath, 'WinKeyServer.exe')
  }

  const buildDir = __dirname.includes(join('out', 'main'))
    ? join(__dirname, '..', '..', 'src', 'native-keyboard-listener', 'WinKeyServer', 'build')
    : join(__dirname, '..', 'native-keyboard-listener', 'WinKeyServer', 'build')

  const candidateNames = existsSync(buildDir)
    ? readdirSync(buildDir).filter((name) => /^WinKeyServer(?:-\d+)?\.exe$/i.test(name))
    : []

  if (candidateNames.length > 0) {
    const newestPath = candidateNames
      .map((name) => join(buildDir, name))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]

    if (newestPath) {
      return newestPath
    }
  }

  if (__dirname.includes(join('out', 'main'))) {
    return join(__dirname, '..', '..', 'src', 'native-keyboard-listener', 'WinKeyServer', 'build', 'WinKeyServer.exe')
  }

  return join(__dirname, '..', 'native-keyboard-listener', 'WinKeyServer', 'build', 'WinKeyServer.exe')
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

    keyboardListener.on('start-error', () => {
      if (!this.started) return
      this.started = false
      this.emit('exit', null)
    })
  }

  start(): boolean {
    if (this.started && keyboardListener.isReady()) {
      return true
    }

    if (this.started) {
      return false
    }

    const started = keyboardListener.start()
    if (started) {
      this.started = true
      this.applyShortcuts()
    }
    return started
  }

  forceRestart(): boolean {
    const restarted = keyboardListener.forceRestart()
    this.started = restarted
    if (restarted) {
      this.applyShortcuts()
    }
    return restarted
  }

  stop(): void {
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

class WindowsNativeShortcutBackend extends EventEmitter implements ShortcutBackend {
  readonly id: ShortcutBackendState = 'native'
  readonly capabilities: ShortcutBackendCapabilities = {
    global: true,
    sideAware: true,
    supportsModifierOnly: true,
    requiresAccessibility: false
  }

  private started = false
  private shortcuts: ShortcutRegistration[] = []
  private parsedShortcuts = new Map<VoiceMode, ParsedShortcut>()
  private blockedModifierOnlyKeys = new Set<string>()
  private currentModifiers = new Set<string>()
  private currentKeys = new Set<string>()
  private listener: {
    addListener: (handler: (event: Record<string, unknown>, down?: unknown) => boolean) => Promise<void> | void
    removeListener?: (handler: (event: Record<string, unknown>, down?: unknown) => boolean) => void
    kill?: () => void
  } | null = null
  private keyHandler: ((event: Record<string, unknown>, down?: unknown) => boolean) | null = null

  start(): boolean {
    if (this.started) return true

    try {
      const serverPath = this.resolveServerPath()
      if (!serverPath) {
        console.warn('[WindowsNativeShortcutBackend] WinKeyServer.exe is missing; native shortcut backend unavailable')
        return false
      }

      const listener = new WindowsGlobalKeyboardListener({
        serverPath,
        onInfo: (message) => {
          const text = message.trim()
          if (text) {
            console.log(`[WindowsNativeShortcutBackend] ${text}`)
          }
        },
        onError: (code) => {
          console.warn('[WindowsNativeShortcutBackend] Listener exited:', code)
          this.handleStartupFailure()
        }
      })
      const keyHandler = (event: Record<string, unknown>, down?: unknown) => this.handleKeyEvent(event, down)
      this.listener = listener
      this.keyHandler = keyHandler
      this.started = true
      this.applyShortcuts()

      void Promise.resolve(listener.addListener(keyHandler)).catch((error) => {
        console.warn('[WindowsNativeShortcutBackend] Failed to start listener:', error)
        this.handleStartupFailure()
      })

      return true
    } catch (error) {
      console.warn('[WindowsNativeShortcutBackend] Failed to start:', error)
      this.handleStartupFailure()
      return false
    }
  }

  stop(): void {
    if (this.listener?.removeListener && this.keyHandler) {
      this.listener.removeListener(this.keyHandler)
    }
    if (this.listener?.kill) {
      this.listener.kill()
    }

    this.started = false
    this.listener = null
    this.keyHandler = null
    this.currentModifiers.clear()
    this.currentKeys.clear()
    this.parsedShortcuts.clear()
  }

  setShortcuts(shortcuts: ShortcutRegistration[]): void {
    this.shortcuts = shortcuts
    this.applyShortcuts()
  }

  isAvailable(): boolean {
    return this.started
  }

  private applyShortcuts(): void {
    this.parsedShortcuts.clear()
    this.blockedModifierOnlyKeys.clear()
    for (const shortcut of this.shortcuts) {
      const parsedShortcut = parseShortcut(shortcut.shortcut)
      this.parsedShortcuts.set(shortcut.id, parsedShortcut)

      const blockedKey = this.getBlockedModifierOnlyKey(parsedShortcut)
      if (blockedKey) {
        this.blockedModifierOnlyKeys.add(blockedKey)
      }
    }
  }

  private handleKeyEvent(event: Record<string, unknown>, down?: unknown): boolean {
    if (!this.started) return false

    const state = String(event.state ?? '').toUpperCase()
    const isKeyDown = state === 'DOWN' || state === 'KEY_DOWN' || down === true
    const isKeyUp = state === 'UP' || state === 'KEY_UP' || down === false

    if (!isKeyDown && !isKeyUp) return false

    const normalized = this.normalizeEventKey(event)
    if (!normalized) return false

    if (isKeyDown) {
      let stopPropagation = this.blockedModifierOnlyKeys.has(normalized.key)

      if (normalized.isEscape) {
        this.emit('escape')
      }

      if (normalized.modifierName) {
        this.currentModifiers.add(normalized.modifierName)
      }
      this.currentKeys.add(normalized.key)

      for (const shortcut of this.shortcuts) {
        const parsed = this.parsedShortcuts.get(shortcut.id)
        if (!parsed) continue

        if (matchShortcut(Array.from(this.currentModifiers), Array.from(this.currentKeys), parsed, normalized.key)) {
          this.emit('trigger', shortcut.id, shortcut.shortcut)
          stopPropagation = true
        }
      }

      return stopPropagation
    }

    if (normalized.modifierName) {
      this.currentModifiers.delete(normalized.modifierName)
    }
    this.currentKeys.delete(normalized.key)

    return this.blockedModifierOnlyKeys.has(normalized.key)
  }

  private normalizeEventKey(event: Record<string, unknown>): { key: string; modifierName?: string; isEscape?: boolean } | null {
    const raw = String(event.name ?? event.key ?? '').toUpperCase().trim()
    if (!raw) return null

    const mappedModifiers: Record<string, { key: string; modifierName: string }> = {
      'RIGHT CTRL': { key: 'ControlRight', modifierName: 'Control' },
      'RIGHT CONTROL': { key: 'ControlRight', modifierName: 'Control' },
      'LEFT CTRL': { key: 'ControlLeft', modifierName: 'Control' },
      'LEFT CONTROL': { key: 'ControlLeft', modifierName: 'Control' },
      'RIGHT ALT': { key: 'AltRight', modifierName: 'Alt' },
      'LEFT ALT': { key: 'AltLeft', modifierName: 'Alt' },
      'RIGHT SHIFT': { key: 'ShiftRight', modifierName: 'Shift' },
      'LEFT SHIFT': { key: 'ShiftLeft', modifierName: 'Shift' },
      'RIGHT WIN': { key: 'MetaRight', modifierName: 'Meta' },
      'RIGHT WINDOWS': { key: 'MetaRight', modifierName: 'Meta' },
      'LEFT WIN': { key: 'MetaLeft', modifierName: 'Meta' },
      'LEFT WINDOWS': { key: 'MetaLeft', modifierName: 'Meta' }
    }

    if (raw in mappedModifiers) {
      return mappedModifiers[raw]
    }

    if (raw === 'ESC' || raw === 'ESCAPE') {
      return { key: 'Escape', isEscape: true }
    }

    if (raw.length === 1) {
      return { key: raw }
    }

    if (/^F\d+$/.test(raw)) {
      return { key: raw }
    }

    const mappedKeys: Record<string, string> = {
      SPACE: 'Space',
      ENTER: 'Return',
      TAB: 'Tab',
      BACKSPACE: 'Backspace',
      DELETE: 'Delete',
      UP: 'Up',
      DOWN: 'Down',
      LEFT: 'Left',
      RIGHT: 'Right'
    }

    return { key: mappedKeys[raw] || raw }
  }

  private resolveServerPath(): string | null {
    const bundledServerPath = resolveBundledWindowsKeyServerPath()
    return existsSync(bundledServerPath) ? bundledServerPath : null
  }

  private handleStartupFailure(): void {
    if (this.listener?.kill) {
      this.listener.kill()
    }

    this.started = false
    this.listener = null
    this.keyHandler = null
    this.currentModifiers.clear()
    this.currentKeys.clear()
    this.parsedShortcuts.clear()
    this.blockedModifierOnlyKeys.clear()
    this.emit('exit', null)
  }

  private getBlockedModifierOnlyKey(parsedShortcut: ParsedShortcut): string | null {
    if (parsedShortcut.key || parsedShortcut.modifiers.length !== 1 || parsedShortcut.side === 'any') {
      return null
    }

    const modifier = parsedShortcut.modifiers[0]
    const side = parsedShortcut.side.charAt(0).toUpperCase() + parsedShortcut.side.slice(1)
    return `${modifier}${side}`
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
  private conflictedModes = new Set<VoiceMode>()

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

  getConflictedModes(): Set<VoiceMode> {
    return new Set(this.conflictedModes)
  }

  private unregisterAll(): void {
    for (const accelerator of this.registeredAccelerators) {
      globalShortcut.unregister(accelerator)
    }
    this.registeredAccelerators = []
    this.registeredModes.clear()
    this.conflictedModes.clear()
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
        this.conflictedModes.add(shortcut.id)
        this.emit('register-failed', shortcut)
      }
    }
  }
}

export class ShortcutService extends EventEmitter {
  private readonly configStore: ConfigStore
  private readonly pipeline: Pipeline
  private readonly platform: NodeJS.Platform
  private readonly fallbackBackend = new GlobalShortcutFallbackBackend()
  private readonly nativeBackend?: ShortcutBackend
  private readonly macNativeBackend?: MacNativeShortcutBackend
  private status: ShortcutServiceStatus
  private lastTriggerTime = 0
  private readonly debounceMs = 300
  private accessibilityPollTimer: ReturnType<typeof setInterval> | null = null
  private accessibilityPollAttempts = 0
  private nativeBackendReady = false
  private shortcutCaptureActive = false

  constructor(configStore: ConfigStore, pipeline: Pipeline, platform: NodeJS.Platform = process.platform) {
    super()
    this.configStore = configStore
    this.pipeline = pipeline
    this.platform = platform
    this.status = this.buildEmptyStatus()

    if (platform === 'darwin') {
      const backend = new MacNativeShortcutBackend()
      this.nativeBackend = backend
      this.macNativeBackend = backend
    } else if (platform === 'win32') {
      this.nativeBackend = new WindowsNativeShortcutBackend()
    }

    this.nativeBackend?.on('trigger', (mode: VoiceMode) => this.handleShortcutTriggered(mode))
    this.nativeBackend?.on('escape', () => {
      if (!this.shortcutCaptureActive) {
        this.pipeline.cancel()
      }
    })
    this.nativeBackend?.on('exit', () => {
      this.nativeBackendReady = false
      this.refresh()
    })

    this.fallbackBackend.on('trigger', (mode: VoiceMode) => this.handleShortcutTriggered(mode))
  }

  start(): void {
    this.refresh()
  }

  destroy(): void {
    this.stopAccessibilityPolling()
    this.nativeBackendReady = false
    this.nativeBackend?.stop()
    this.fallbackBackend.stop()
  }

  refresh(): ShortcutServiceStatus {
    const config = getConfig(this.configStore)
    const permissions = checkPermissions()
    const shortcuts = this.buildShortcutRegistrations(config)
    const nativeRequiresAccessibility = this.nativeBackend?.capabilities.requiresAccessibility ?? false
    const nativeAllowed = !!this.nativeBackend && (!nativeRequiresAccessibility || permissions.accessibility)

    let backendState: ShortcutBackendState = 'disabled'
    let reason: ShortcutStatusReason = permissions.accessibility ? 'backend_failed' : 'permission_missing'
    let registeredFallbackModes = new Set<VoiceMode>()
    let conflictedFallbackModes = new Set<VoiceMode>()

    if (nativeAllowed && this.nativeBackend) {
      this.stopAccessibilityPolling()
      this.fallbackBackend.stop()

      const started = this.nativeBackend.start()
      if (started && this.nativeBackend.isAvailable()) {
        this.nativeBackend.setShortcuts(shortcuts.filter((shortcut) => isValidShortcut(shortcut.shortcut)))
        this.nativeBackendReady = true
        backendState = 'native'
        reason = 'ready'
      } else {
        this.nativeBackendReady = false
      }
    } else {
      this.nativeBackendReady = false
      this.nativeBackend?.stop()
      if (this.platform === 'darwin') {
        this.stopAccessibilityPolling()
      }
    }

    if (backendState !== 'native') {
      const fallbackShortcuts = shortcuts.filter((shortcut) => isFallbackCompatible(shortcut.shortcut))
      if (fallbackShortcuts.length > 0) {
        this.fallbackBackend.start()
        this.fallbackBackend.setShortcuts(fallbackShortcuts)
        registeredFallbackModes = this.fallbackBackend.getRegisteredModes()
        conflictedFallbackModes = this.fallbackBackend.getConflictedModes()

        if (registeredFallbackModes.size > 0) {
          backendState = 'fallback'
          reason = 'ready'
        } else if (conflictedFallbackModes.size > 0) {
          reason = 'shortcut_conflict'
        }
      } else {
        this.fallbackBackend.stop()
      }
    }

    const modes = shortcuts.reduce<Record<VoiceMode, ShortcutModeStatus>>((result, shortcut) => {
      const valid = isValidShortcut(shortcut.shortcut)
      const fallbackCompatible = isFallbackCompatible(shortcut.shortcut)
      const requiresAccessibility = !!this.nativeBackend?.capabilities.requiresAccessibility && !fallbackCompatible

      let modeBackendState: ShortcutBackendState = 'disabled'
      let modeReason: ShortcutStatusReason = permissions.accessibility ? 'backend_failed' : 'permission_missing'
      let canTriggerGlobally = false

      if (valid && backendState === 'native' && nativeAllowed) {
        modeBackendState = 'native'
        modeReason = 'ready'
        canTriggerGlobally = true
      } else if (valid && backendState === 'fallback' && registeredFallbackModes.has(shortcut.id)) {
        modeBackendState = 'fallback'
        modeReason = 'ready'
        canTriggerGlobally = true
      } else if (conflictedFallbackModes.has(shortcut.id)) {
        modeReason = 'shortcut_conflict'
      } else if (valid && requiresAccessibility && !permissions.accessibility) {
        modeReason = 'unsupported_without_accessibility'
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
      permissionState: permissions.accessibility ? 'granted' : 'missing',
      backendState,
      reason,
      modes
    }

    this.applyShortcutCaptureState()
    this.emit('status-changed', { status: this.status } satisfies ShortcutStatusChangedEvent)
    return this.status
  }

  getStatus(): ShortcutServiceStatus {
    return this.status
  }

  updateShortcut(_mode: VoiceMode, _shortcut: string): ShortcutServiceStatus {
    return this.refresh()
  }

  setShortcutCaptureActive(active: boolean): void {
    if (this.shortcutCaptureActive === active) return

    this.shortcutCaptureActive = active
    this.applyShortcutCaptureState()
  }

  beginAccessibilityPolling(): void {
    if (this.platform !== 'darwin') return
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

  async ensureNativeBackendReady(maxAttempts = 15, delayMs = 300): Promise<boolean> {
    if (!this.nativeBackend) {
      return false
    }

    if (this.platform !== 'darwin') {
      const started = this.nativeBackend.start()
      if (started) {
        this.nativeBackendReady = true
        this.refresh()
      }
      return started
    }

    if (!checkPermissions().accessibility || !this.macNativeBackend) {
      return false
    }

    if (this.nativeBackendReady && this.macNativeBackend.isAvailable()) {
      return true
    }

    this.nativeBackendReady = false

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      this.macNativeBackend.forceRestart()
      await new Promise((resolve) => setTimeout(resolve, delayMs))

      if (this.macNativeBackend.isAvailable()) {
        this.nativeBackendReady = true
        this.refresh()
        return true
      }
    }

    return false
  }

  private handleShortcutTriggered(mode: VoiceMode): void {
    if (this.shortcutCaptureActive) return

    const now = Date.now()
    if (now - this.lastTriggerTime < this.debounceMs) return

    this.lastTriggerTime = now
    void this.pipeline.toggle(mode)
  }

  private applyShortcutCaptureState(): void {
    if (this.shortcutCaptureActive) {
      this.nativeBackend?.setShortcuts([])
      if (this.fallbackBackend.isAvailable()) {
        this.fallbackBackend.setShortcuts([])
      }
      return
    }

    const shortcuts = this.buildShortcutRegistrations(getConfig(this.configStore))
    if (this.status.backendState === 'native' && this.nativeBackend?.isAvailable()) {
      this.nativeBackend.setShortcuts(shortcuts.filter((shortcut) => isValidShortcut(shortcut.shortcut)))
    }

    if (this.status.backendState === 'fallback' && this.fallbackBackend.isAvailable()) {
      this.fallbackBackend.setShortcuts(shortcuts.filter((shortcut) => isFallbackCompatible(shortcut.shortcut)))
    }
  }

  private buildShortcutRegistrations(config: ReturnType<typeof getConfig>): ShortcutRegistration[] {
    return [
      {
        id: 'transcription',
        shortcut: config.transcriptionShortcut || getDefaultTranscriptionShortcut(this.platform)
      },
      {
        id: 'assistant',
        shortcut: config.assistantShortcut || getDefaultAssistantShortcut(this.platform)
      }
    ]
  }

  private buildEmptyStatus(): ShortcutServiceStatus {
    const permissionState = this.platform === 'darwin' ? 'missing' : 'granted'
    const defaultReason: ShortcutStatusReason = permissionState === 'granted' ? 'backend_failed' : 'permission_missing'

    return {
      permissionState,
      backendState: 'disabled',
      reason: defaultReason,
      modes: {
        transcription: {
          mode: 'transcription',
          shortcut: getDefaultTranscriptionShortcut(this.platform),
          backendState: 'disabled',
          reason: defaultReason,
          requiresAccessibility: this.platform === 'darwin',
          canTriggerGlobally: false
        },
        assistant: {
          mode: 'assistant',
          shortcut: getDefaultAssistantShortcut(this.platform),
          backendState: 'disabled',
          reason: defaultReason,
          requiresAccessibility: this.platform === 'darwin',
          canTriggerGlobally: false
        }
      }
    }
  }
}
