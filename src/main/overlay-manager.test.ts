// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

vi.mock('./mac-native-overlay-backend', () => ({
  MacNativeOverlayBackend: vi.fn()
}))

vi.mock('./electron-overlay-backend', () => ({
  ElectronOverlayBackend: vi.fn()
}))

import { OverlayManager } from './overlay-manager'

function createBackend(id: string, startResult: boolean) {
  return {
    id,
    start: vi.fn(() => startResult),
    destroy: vi.fn(),
    isAvailable: vi.fn(() => startResult),
    showHud: vi.fn(),
    updateHud: vi.fn(),
    hideHud: vi.fn(),
    showResult: vi.fn(),
    hideResult: vi.fn(),
    dismissAll: vi.fn()
  }
}

describe('OverlayManager', () => {
  it('prefers the native backend on macOS when available', () => {
    const nativeBackend = createBackend('native-mac', true)
    const fallbackBackend = createBackend('electron', true)

    const manager = new OverlayManager({
      overlayWindow: null,
      assistantResultWindow: null,
      platform: 'darwin',
      nativeBackend: nativeBackend as never,
      fallbackBackend: fallbackBackend as never
    })

    manager.showHud({
      text: '正在聆听...',
      mode: 'recording',
      voiceMode: 'transcription',
      screenshotActive: false
    })

    expect(nativeBackend.start).toHaveBeenCalledTimes(1)
    expect(fallbackBackend.start).not.toHaveBeenCalled()
    expect(nativeBackend.showHud).toHaveBeenCalled()
  })

  it('falls back to the Electron backend when the native backend is unavailable', () => {
    const nativeBackend = createBackend('native-mac', false)
    const fallbackBackend = createBackend('electron', true)

    const manager = new OverlayManager({
      overlayWindow: null,
      assistantResultWindow: null,
      platform: 'darwin',
      nativeBackend: nativeBackend as never,
      fallbackBackend: fallbackBackend as never
    })

    manager.showResult({
      text: '# Hello',
      format: 'markdown'
    })

    expect(nativeBackend.start).toHaveBeenCalledTimes(1)
    expect(fallbackBackend.start).toHaveBeenCalledTimes(1)
    expect(fallbackBackend.showResult).toHaveBeenCalledWith({
      text: '# Hello',
      format: 'markdown'
    })
  })
})
