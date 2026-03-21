// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  accessibilityGranted: false,
  winServerExists: true,
  windowsListenerConfig: null as Record<string, unknown> | null,
  windowsListenerHandler: null as ((event: Record<string, unknown>, down?: unknown) => boolean) | null,
  currentConfig: {
    transcriptionShortcut: 'RightCommand',
    assistantShortcut: 'RightOption'
  },
  matchShortcutMock: vi.fn(() => false),
  registerMock: vi.fn(() => true),
  unregisterMock: vi.fn(),
  keyboardListenerMock: {
    start: vi.fn(() => true),
    stop: vi.fn(),
    setShortcuts: vi.fn(),
    isRunning: vi.fn(() => true),
    isReady: vi.fn(() => true),
    onShortcut: vi.fn(),
    onKeyDown: vi.fn(),
    onExit: vi.fn(),
    forceRestart: vi.fn(() => true),
    on: vi.fn()
  },
  windowsListenerInstance: {
    addListener: vi.fn((handler: (event: Record<string, unknown>, down?: unknown) => boolean) => {
      mockState.windowsListenerHandler = handler
    }),
    removeListener: vi.fn(),
    kill: vi.fn()
  }
}))

function parseShortcut(shortcut: string): { side: 'left' | 'right' | 'any'; modifiers: string[]; key: string | null } {
  const parts = shortcut.split('+').map((part) => part.trim()).filter(Boolean)
  const result: { side: 'left' | 'right' | 'any'; modifiers: string[]; key: string | null } = {
    side: 'any',
    modifiers: [],
    key: null
  }

  for (const part of parts) {
    if (part.startsWith('Left')) {
      result.side = 'left'
      result.modifiers.push(part.replace('Left', '').replace('Command', 'Meta').replace('Option', 'Alt').replace('Ctrl', 'Control'))
    } else if (part.startsWith('Right')) {
      result.side = 'right'
      result.modifiers.push(part.replace('Right', '').replace('Command', 'Meta').replace('Option', 'Alt').replace('Ctrl', 'Control'))
    } else if (['Command', 'Meta'].includes(part)) {
      result.modifiers.push('Meta')
    } else if (['Ctrl', 'Control'].includes(part)) {
      result.modifiers.push('Control')
    } else if (['Alt', 'Option'].includes(part)) {
      result.modifiers.push('Alt')
    } else if (part === 'Shift') {
      result.modifiers.push('Shift')
    } else {
      result.key = part
    }
  }

  return result
}

vi.mock('electron', () => ({
  globalShortcut: {
    register: mockState.registerMock,
    unregister: mockState.unregisterMock
  }
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (/WinKeyServer(?:-\d+)?\.exe$/i.test(path)) {
        return mockState.winServerExists
      }
      return actual.existsSync(path)
    })
  }
})

vi.mock('./windows-global-key-listener', () => ({
  WindowsGlobalKeyboardListener: class MockWindowsGlobalKeyboardListener {
    constructor(config?: Record<string, unknown>) {
      mockState.windowsListenerConfig = config ?? null
      return mockState.windowsListenerInstance
    }
  }
}))

vi.mock('../native-keyboard-listener', () => ({
  keyboardListener: mockState.keyboardListenerMock,
  parseShortcut,
  matchShortcut: mockState.matchShortcutMock
}))

vi.mock('./config-store', () => ({
  getConfig: () => mockState.currentConfig
}))

vi.mock('./permissions', () => ({
  checkPermissions: () => ({
    microphone: true,
    accessibility: mockState.accessibilityGranted,
    screen: false
  })
}))

import { ShortcutService } from './shortcut'

describe('ShortcutService', () => {
  beforeEach(() => {
    mockState.accessibilityGranted = false
    mockState.winServerExists = true
    mockState.windowsListenerConfig = null
    mockState.windowsListenerHandler = null
    mockState.currentConfig = {
      transcriptionShortcut: 'RightCommand',
      assistantShortcut: 'RightOption'
    }
    mockState.registerMock.mockReset()
    mockState.unregisterMock.mockReset()
    mockState.matchShortcutMock.mockReset()
    mockState.matchShortcutMock.mockReturnValue(false)
    mockState.registerMock.mockReturnValue(true)
    mockState.keyboardListenerMock.start.mockReset()
    mockState.keyboardListenerMock.start.mockReturnValue(true)
    mockState.keyboardListenerMock.stop.mockReset()
    mockState.keyboardListenerMock.forceRestart.mockReset()
    mockState.keyboardListenerMock.forceRestart.mockReturnValue(true)
    mockState.keyboardListenerMock.setShortcuts.mockReset()
    mockState.keyboardListenerMock.isRunning.mockReset()
    mockState.keyboardListenerMock.isRunning.mockReturnValue(true)
    mockState.keyboardListenerMock.isReady.mockReset()
    mockState.keyboardListenerMock.isReady.mockReturnValue(true)
    mockState.keyboardListenerMock.on.mockReset()
    mockState.windowsListenerInstance.addListener.mockReset()
    mockState.windowsListenerInstance.removeListener.mockReset()
    mockState.windowsListenerInstance.kill.mockReset()
    vi.useRealTimers()
  })

  it('falls back to Electron global shortcuts when accessibility is missing and shortcut is compatible', () => {
    mockState.currentConfig = {
      transcriptionShortcut: 'Command+Space',
      assistantShortcut: 'RightOption'
    }

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never, 'darwin')

    const status = service.refresh()

    expect(mockState.registerMock).toHaveBeenCalledWith('Command+Space', expect.any(Function))
    expect(status.backendState).toBe('fallback')
    expect(status.modes.transcription.backendState).toBe('fallback')
    expect(status.modes.assistant.reason).toBe('unsupported_without_accessibility')
  })

  it('starts the mac native backend when accessibility is granted', () => {
    mockState.accessibilityGranted = true

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never, 'darwin')

    const status = service.refresh()

    expect(mockState.keyboardListenerMock.start).toHaveBeenCalled()
    expect(mockState.keyboardListenerMock.setShortcuts).toHaveBeenCalled()
    expect(status.backendState).toBe('native')
  })

  it('reports shortcut conflicts from the fallback backend', () => {
    mockState.currentConfig = {
      transcriptionShortcut: 'Command+Space',
      assistantShortcut: 'Ctrl+Shift+A'
    }
    mockState.registerMock
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never, 'darwin')

    const status = service.refresh()

    expect(status.modes.transcription.reason).toBe('shortcut_conflict')
    expect(status.modes.assistant.backendState).toBe('fallback')
  })

  it('does not crash on Windows when the native key server executable is missing', () => {
    mockState.accessibilityGranted = true
    mockState.winServerExists = false
    mockState.currentConfig = {
      transcriptionShortcut: 'RightAlt',
      assistantShortcut: 'RightControl'
    }

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never, 'win32')

    const status = service.refresh()
    service.destroy()

    expect(status.backendState).toBe('disabled')
    expect(status.reason).toBe('backend_failed')
    expect(status.modes.transcription.canTriggerGlobally).toBe(false)
    expect(status.modes.assistant.canTriggerGlobally).toBe(false)
  })

  it('starts the Windows native backend with the bundled helper path', () => {
    mockState.accessibilityGranted = true
    mockState.currentConfig = {
      transcriptionShortcut: 'RightAlt',
      assistantShortcut: 'RightControl'
    }

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never, 'win32')

    const status = service.refresh()
    service.destroy()

    expect(status.backendState).toBe('native')
    expect(status.modes.transcription.canTriggerGlobally).toBe(true)
    expect(status.modes.assistant.canTriggerGlobally).toBe(true)
  })

  it('suppresses registered modifier-only RightAlt and RightControl events on Windows', () => {
    mockState.accessibilityGranted = true
    mockState.currentConfig = {
      transcriptionShortcut: 'RightAlt',
      assistantShortcut: 'RightControl'
    }

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never, 'win32')

    service.refresh()

    const nativeBackend = (service as unknown as { nativeBackend?: { handleKeyEvent?: (event: Record<string, unknown>, down?: unknown) => boolean } }).nativeBackend

    expect(nativeBackend?.handleKeyEvent).toBeDefined()
    expect(nativeBackend?.handleKeyEvent?.({ state: 'DOWN', name: 'RIGHT ALT' })).toBe(true)
    expect(nativeBackend?.handleKeyEvent?.({ state: 'UP', name: 'RIGHT ALT' })).toBe(true)
    expect(nativeBackend?.handleKeyEvent?.({ state: 'DOWN', name: 'RIGHT CONTROL' })).toBe(true)
    expect(nativeBackend?.handleKeyEvent?.({ state: 'UP', name: 'RIGHT CONTROL' })).toBe(true)
    expect(nativeBackend?.handleKeyEvent?.({ state: 'DOWN', name: 'A' })).toBe(false)

    service.destroy()
  })

})
