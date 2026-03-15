// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

vi.mock('./mac-native-overlay-backend', () => ({
  MacNativeOverlayBackend: vi.fn()
}))

vi.mock('./electron-overlay-backend', () => ({
  ElectronOverlayBackend: vi.fn()
}))

import { OverlayManager } from './overlay-manager'

function createBackend(id: string, available: boolean) {
  return {
    id,
    start: vi.fn(() => true),
    destroy: vi.fn(),
    isAvailable: vi.fn(() => available),
    showHud: vi.fn(),
    updateHud: vi.fn(),
    hideHud: vi.fn(),
    showResult: vi.fn(),
    hideResult: vi.fn(),
    dismissAll: vi.fn()
  }
}

describe('OverlayManager', () => {
  it('uses the native backend when available', () => {
    const nativeBackend = createBackend('native-mac', true)
    const fallbackBackend = createBackend('electron', true)

    const manager = new OverlayManager({
      overlayWindow: null,
      getAssistantResultWindow: () => null,
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

    // Native backend is available, so it should be used
    expect(nativeBackend.showHud).toHaveBeenCalled()
    expect(fallbackBackend.showHud).not.toHaveBeenCalled()
  })

  it('falls back to the Electron backend when the native backend is unavailable', () => {
    const nativeBackend = createBackend('native-mac', false)
    const fallbackBackend = createBackend('electron', true)

    const manager = new OverlayManager({
      overlayWindow: null,
      getAssistantResultWindow: () => null,
      platform: 'darwin',
      nativeBackend: nativeBackend as never,
      fallbackBackend: fallbackBackend as never
    })

    manager.showResult({
      text: '# Hello',
      format: 'markdown'
    })

    // Native backend is not available, fallback should be used
    expect(fallbackBackend.start).toHaveBeenCalled()
    expect(fallbackBackend.showResult).toHaveBeenCalledWith({
      text: '# Hello',
      format: 'markdown'
    })
  })

  it('switches to native backend when it becomes available', () => {
    const nativeBackend = createBackend('native-mac', false)
    const fallbackBackend = createBackend('electron', true)

    const manager = new OverlayManager({
      overlayWindow: null,
      getAssistantResultWindow: () => null,
      platform: 'darwin',
      nativeBackend: nativeBackend as never,
      fallbackBackend: fallbackBackend as never
    })

    // First call uses fallback
    manager.showHud({
      text: '正在聆听...',
      mode: 'recording',
      voiceMode: 'transcription',
      screenshotActive: false
    })

    expect(fallbackBackend.showHud).toHaveBeenCalled()

    // Native backend becomes available
    nativeBackend.isAvailable = vi.fn(() => true)

    // Second call should use native
    manager.showHud({
      text: '正在处理...',
      mode: 'processing',
      voiceMode: 'transcription',
      screenshotActive: false
    })

    expect(nativeBackend.showHud).toHaveBeenCalled()
  })
})
