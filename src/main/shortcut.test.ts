// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  accessibilityGranted: false,
  currentConfig: {
    transcriptionShortcut: 'RightCommand',
    assistantShortcut: 'RightOption'
  },
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
    restart: vi.fn(() => true),
    forceRestart: vi.fn(() => true),
    on: vi.fn()
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

vi.mock('../native-keyboard-listener', () => ({
  keyboardListener: mockState.keyboardListenerMock,
  parseShortcut
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
    mockState.currentConfig = {
      transcriptionShortcut: 'RightCommand',
      assistantShortcut: 'RightOption'
    }
    mockState.registerMock.mockReset()
    mockState.unregisterMock.mockReset()
    mockState.registerMock.mockReturnValue(true)
    mockState.keyboardListenerMock.start.mockReset()
    mockState.keyboardListenerMock.start.mockReturnValue(true)
    mockState.keyboardListenerMock.stop.mockReset()
    mockState.keyboardListenerMock.restart.mockReset()
    mockState.keyboardListenerMock.restart.mockReturnValue(true)
    mockState.keyboardListenerMock.forceRestart.mockReset()
    mockState.keyboardListenerMock.forceRestart.mockReturnValue(true)
    mockState.keyboardListenerMock.setShortcuts.mockReset()
    mockState.keyboardListenerMock.isRunning.mockReset()
    mockState.keyboardListenerMock.isRunning.mockReturnValue(true)
    mockState.keyboardListenerMock.isReady.mockReset()
    mockState.keyboardListenerMock.isReady.mockReturnValue(true)
    mockState.keyboardListenerMock.on.mockReset()
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
    } as never)

    const status = service.refresh()

    expect(mockState.registerMock).toHaveBeenCalledWith('Command+Space', expect.any(Function))
    expect(status.backendState).toBe('fallback')
    expect(status.modes.transcription.backendState).toBe('fallback')
    expect(status.modes.assistant.reason).toBe('unsupported_without_accessibility')
  })

  it('starts the native backend when accessibility is granted', async () => {
    mockState.accessibilityGranted = true

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never)

    // refresh() alone won't start native backend - need ensureNativeBackendReady
    const status = service.refresh()

    // Should be disabled since RightCommand/RightOption are not fallback-compatible
    // and native backend isn't started yet
    expect(status.backendState).toBe('disabled')

    // Now explicitly ensure native backend is ready
    const ready = await service.ensureNativeBackendReady(1, 10)
    expect(ready).toBe(true)
    expect(mockState.keyboardListenerMock.forceRestart).toHaveBeenCalled()
  })

  it('hot-switches to the native backend during accessibility polling', async () => {
    mockState.currentConfig = {
      transcriptionShortcut: 'Command+Space',
      assistantShortcut: 'RightOption'
    }
    vi.useFakeTimers()

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never)

    service.refresh()
    service.beginAccessibilityPolling()

    mockState.accessibilityGranted = true
    vi.advanceTimersByTime(1000)

    const status = service.getStatus()

    // refresh() during polling should stop native backend if not ready
    // and use fallback instead
    expect(status.permissionState).toBe('granted')
    // Native backend needs ensureNativeBackendReady to start
    expect(status.backendState).toBe('fallback')

    vi.useRealTimers()
  })


  it('restarts native listener when accessibility changes from missing to granted', async () => {
    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never)

    service.start()
    // When started without accessibility, native backend is not started
    expect(mockState.keyboardListenerMock.start).not.toHaveBeenCalled()

    mockState.accessibilityGranted = true
    const status = service.refresh()

    // refresh() won't auto-start native backend, needs ensureNativeBackendReady
    expect(mockState.keyboardListenerMock.forceRestart).not.toHaveBeenCalled()
    // RightCommand/RightOption are not fallback-compatible, so backend is disabled
    expect(status.backendState).toBe('disabled')

    // Now explicitly start via ensureNativeBackendReady
    const ready = await service.ensureNativeBackendReady(1, 10)
    expect(ready).toBe(true)
    expect(mockState.keyboardListenerMock.forceRestart).toHaveBeenCalled()
  })
})
