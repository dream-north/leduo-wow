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
    onShortcut: vi.fn(),
    onKeyDown: vi.fn(),
    onExit: vi.fn()
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
    mockState.keyboardListenerMock.setShortcuts.mockReset()
    mockState.keyboardListenerMock.isRunning.mockReset()
    mockState.keyboardListenerMock.isRunning.mockReturnValue(true)
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

  it('starts the native backend when accessibility is granted', () => {
    mockState.accessibilityGranted = true

    const service = new ShortcutService({} as never, {
      toggle: vi.fn(),
      cancel: vi.fn()
    } as never)

    const status = service.refresh()

    expect(mockState.keyboardListenerMock.start).toHaveBeenCalledTimes(1)
    expect(mockState.keyboardListenerMock.setShortcuts).toHaveBeenCalledWith([
      { id: 'transcription', shortcut: 'RightCommand' },
      { id: 'assistant', shortcut: 'RightOption' }
    ])
    expect(status.backendState).toBe('native')
    expect(status.modes.transcription.backendState).toBe('native')
    expect(status.modes.assistant.backendState).toBe('native')
  })

  it('hot-switches to the native backend during accessibility polling', () => {
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

    expect(mockState.keyboardListenerMock.start).toHaveBeenCalled()
    expect(status.permissionState).toBe('granted')
    expect(status.backendState).toBe('native')
  })
})
