import { flushPromises, mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ScreenDocHistoryRecord, ScreenDocStatusPayload, ShortcutServiceStatus, UpdateStatusPayload } from '../../../shared/types'
import { DEFAULT_CONFIG } from '../../../shared/types'
import SettingsView from './SettingsView.vue'

class MockAudioContext {
  sampleRate = 16000
  destination = {}
  createMediaStreamSource = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn()
  }))
  createScriptProcessor = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null
  }))
  close = vi.fn(async () => {})
}

function createElectronApi(overrides: Partial<Window['electronAPI']> = {}): Window['electronAPI'] {
  const shortcutStatus: ShortcutServiceStatus = {
    permissionState: 'granted',
    backendState: 'native',
    reason: 'ready',
    modes: {
      transcription: {
        mode: 'transcription',
        shortcut: 'RightCommand',
        backendState: 'native',
        reason: 'ready',
        requiresAccessibility: true,
        canTriggerGlobally: true
      },
      assistant: {
        mode: 'assistant',
        shortcut: 'RightOption',
        backendState: 'native',
        reason: 'ready',
        requiresAccessibility: true,
        canTriggerGlobally: true
      }
    }
  }

  const updateStatus: UpdateStatusPayload = {
    status: 'idle',
    currentVersion: '0.9.9'
  }

  const screenDocStatus: ScreenDocStatusPayload = {
    status: 'idle',
    captureBackend: 'native'
  }
  const screenDocHistory: ScreenDocHistoryRecord[] = []

  return {
    platform: 'darwin',
    getConfig: vi.fn(async () => ({
      ...DEFAULT_CONFIG,
      asrApiKey: 'sk-asr',
      polishApiKey: 'sk-polish'
    })),
    getConfigValue: vi.fn(async () => undefined),
    setConfig: vi.fn(async () => true),
    checkPermissions: vi.fn(async () => ({
      microphone: true,
      accessibility: true,
      screen: true
    })),
    requestPermission: vi.fn(async () => true),
    getShortcutStatus: vi.fn(async () => shortcutStatus),
    refreshShortcutStatus: vi.fn(async () => shortcutStatus),
    ensureNativeBackendReady: vi.fn(async () => true),
    setShortcutCaptureActive: vi.fn(async () => true),
    onPipelineStatus: vi.fn(() => () => {}),
    onPartialText: vi.fn(() => () => {}),
    onFinalText: vi.fn(() => () => {}),
    onError: vi.fn(() => () => {}),
    onShortcutStatusChanged: vi.fn(() => () => {}),
    getVersion: vi.fn(async () => '0.9.9'),
    getHistory: vi.fn(async () => []),
    onHistoryUpdated: vi.fn(() => () => {}),
    selectFolder: vi.fn(async () => ''),
    openPath: vi.fn(async () => ''),
    getRunningApps: vi.fn(async () => []),
    onDockUpdateLock: vi.fn(() => () => {}),
    checkForUpdate: vi.fn(async () => updateStatus),
    downloadUpdate: vi.fn(async () => {}),
    installUpdate: vi.fn(async () => {}),
    getUpdateStatus: vi.fn(async () => updateStatus),
    onUpdateStatus: vi.fn(() => () => {}),
    startScreenDoc: vi.fn(async () => ({ ok: true })),
    getScreenDocStatus: vi.fn(async () => screenDocStatus),
    stopScreenDoc: vi.fn(async () => null),
    cancelScreenDoc: vi.fn(async () => true),
    sendScreenDocAudioChunk: vi.fn(),
    getScreenDocHistory: vi.fn(async () => screenDocHistory),
    getScreenDocHistoryRecord: vi.fn(async () => null),
    reanalyzeScreenDocRecord: vi.fn(async () => null),
    openScreenDocRecordFolder: vi.fn(async () => null),
    previewScreenDocRecord: vi.fn(async () => null),
    exportScreenDocRecord: vi.fn(async () => null),
    deleteScreenDocRecord: vi.fn(async () => true),
    onScreenDocHistoryUpdated: vi.fn(() => () => {}),
    getLatestScreenDocResult: vi.fn(async () => null),
    onScreenDocStatus: vi.fn(() => () => {}),
    getPersonalVocabulary: vi.fn(async () => []),
    getSharedVocabulary: vi.fn(async () => []),
    addVocabulary: vi.fn(async () => ({ entry: undefined as never, duplicate: false })),
    updateVocabulary: vi.fn(async () => true),
    deleteVocabulary: vi.fn(async () => true),
    importVocabulary: vi.fn(async () => ({ added: 0, skipped: 0 })),
    exportVocabulary: vi.fn(async () => ({
      version: 1,
      exportedAt: Date.now(),
      entries: []
    })),
    getVocabularyStats: vi.fn(async () => ({
      personalCount: 0,
      sharedCount: 0,
      activeCount: 0
    })),
    syncSharedVocabulary: vi.fn(async () => ({ synced: 0 })),
    syncVocabularyFromUrl: vi.fn(async () => ({ total: 0 })),
    removeVocabularySource: vi.fn(async () => {}),
    previewMerge: vi.fn(async () => ({
      items: [],
      newCount: 0,
      conflictCount: 0,
      unchangedCount: 0,
      remoteOnlyCount: 0
    })),
    executeMerge: vi.fn(async () => ({ success: true })),
    testWriteToken: vi.fn(async () => ({ success: true })),
    onVocabularyUpdated: vi.fn(() => () => {}),
    ...overrides
  }
}

describe('SettingsView screen doc controls', () => {
  beforeEach(() => {
    window.electronAPI = createElectronApi()
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      writable: true,
      value: MockAudioContext
    })

    const track = { stop: vi.fn() }
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        enumerateDevices: vi.fn(async () => [
          { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone' }
        ]),
        getUserMedia: vi.fn(async () => ({
          getTracks: () => [track],
          getAudioTracks: () => [track]
        })),
        getDisplayMedia: vi.fn(async () => {
          throw new Error('should not be called')
        })
      }
    })
  })

  it('starts and stops native screen doc capture without using browser display capture', async () => {
    const wrapper = mount(SettingsView, {
      global: {
        plugins: [createPinia()]
      }
    })
    await flushPromises()

    const screenDocNavButton = wrapper.findAll('.nav-item').find((item) => item.text().includes('录屏整理'))
    expect(screenDocNavButton).toBeTruthy()
    await screenDocNavButton!.trigger('click')
    await flushPromises()

    const primaryButton = wrapper.find('.screen-doc-actions .btn-primary')
    expect(primaryButton.exists()).toBe(true)
    expect(primaryButton.text()).toContain('开始录屏')

    await primaryButton.trigger('click')
    await flushPromises()

    expect(window.electronAPI.startScreenDoc).toHaveBeenCalledOnce()
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledOnce()
    expect(navigator.mediaDevices.getDisplayMedia).not.toHaveBeenCalled()
    expect(wrapper.find('.screen-doc-actions .btn-primary').text()).toContain('停止录制')

    await wrapper.find('.screen-doc-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(window.electronAPI.stopScreenDoc).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.stopScreenDoc).toHaveBeenCalledWith()
  })

  it('hides the cancel button after recording stops and processing begins', async () => {
    let resolveStop: (() => void) | null = null
    window.electronAPI = createElectronApi({
      stopScreenDoc: vi.fn(async (): Promise<null> => await new Promise<null>((resolve) => {
        resolveStop = () => resolve(null)
      }))
    })

    const wrapper = mount(SettingsView, {
      global: {
        plugins: [createPinia()]
      }
    })
    await flushPromises()

    const screenDocNavButton = wrapper.findAll('.nav-item').find((item) => item.text().includes('录屏整理'))
    await screenDocNavButton!.trigger('click')
    await flushPromises()

    const primaryButton = wrapper.find('.screen-doc-actions .btn-primary')
    await primaryButton.trigger('click')
    await flushPromises()

    const cancelButton = wrapper.findAll('.screen-doc-actions .btn-secondary').find((item) => item.text().includes('取消本次'))
    expect(cancelButton?.exists()).toBe(true)

    await wrapper.find('.screen-doc-actions .btn-primary').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.screen-doc-actions .btn-secondary').some((item) => item.text().includes('取消本次'))).toBe(false)

    const finishStop = resolveStop as (() => void) | null
    if (!finishStop) {
      throw new Error('stopScreenDoc mock did not provide a resolver')
    }
    finishStop()
    await flushPromises()
  })

  it('shows record actions, allows canceling active analysis, and allows reanalyzing cancelled history items', async () => {
    const readyRecord: ScreenDocHistoryRecord = {
      id: 'record-1',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: 'ready',
      title: '录屏整理结果',
      summary: '这是摘要',
      stepCount: 2,
      durationMs: 8000,
      storageBytes: 5 * 1024 * 1024,
      hasRecordingFile: true,
      recordingFileName: 'recording.mp4',
      previewHtmlPath: 'preview.html'
    }
    const analyzingRecord: ScreenDocHistoryRecord = {
      id: 'record-2',
      createdAt: Date.now() - 800,
      updatedAt: Date.now() - 300,
      status: 'analyzing',
      title: '正在分析的录屏整理',
      durationMs: 6000,
      storageBytes: 3 * 1024 * 1024,
      hasRecordingFile: true,
      recordingFileName: 'recording.mp4'
    }
    const cancelledRecord: ScreenDocHistoryRecord = {
      id: 'record-3',
      createdAt: Date.now() - 1000,
      updatedAt: Date.now() - 500,
      status: 'cancelled',
      title: '已取消的录屏整理',
      durationMs: 4000,
      storageBytes: 2 * 1024 * 1024,
      hasRecordingFile: true,
      recordingFileName: 'recording.mp4'
    }

    window.electronAPI = createElectronApi({
      getScreenDocStatus: vi.fn(async (): Promise<ScreenDocStatusPayload> => ({
        status: 'analyzing',
        artifactId: 'record-2',
        captureBackend: 'native'
      })),
      getScreenDocHistory: vi.fn(async () => [readyRecord, analyzingRecord, cancelledRecord]),
      getScreenDocHistoryRecord: vi.fn(async () => readyRecord),
      reanalyzeScreenDocRecord: vi.fn(async () => null),
      openScreenDocRecordFolder: vi.fn(async () => '/tmp/screen-doc-history/artifacts/record-1'),
      previewScreenDocRecord: vi.fn(async () => '/tmp/preview.html'),
      exportScreenDocRecord: vi.fn(async () => '/tmp/export'),
      deleteScreenDocRecord: vi.fn(async () => true)
    })
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    const wrapper = mount(SettingsView, {
      global: {
        plugins: [createPinia()]
      }
    })
    await flushPromises()

    const screenDocNavButton = wrapper.findAll('.nav-item').find((item) => item.text().includes('录屏整理'))
    await screenDocNavButton!.trigger('click')
    await flushPromises()

    const historyTab = wrapper.findAll('.mode-tab').find((item) => item.text().includes('历史记录'))
    await historyTab!.trigger('click')
    await flushPromises()

    expect(wrapper.find('.screen-doc-detail-card').exists()).toBe(false)
    expect(wrapper.text()).toContain('5.00 MB')
    expect(wrapper.text()).toContain('原始录屏：已保存')

    const folderButtons = wrapper.findAll('.screen-doc-history-folder-btn')
    await folderButtons[0].trigger('click')

    const actionRows = wrapper.findAll('.screen-doc-history-item-actions')
    const readyButtons = actionRows[0].findAll('.btn')
    await readyButtons[0].trigger('click')
    await readyButtons[1].trigger('click')
    await readyButtons[2].trigger('click')
    const analyzingButtons = actionRows[1].findAll('.btn')
    await analyzingButtons[0].trigger('click')
    const cancelledButtons = actionRows[2].findAll('.btn')
    await cancelledButtons[0].trigger('click')
    await flushPromises()

    expect(window.electronAPI.openScreenDocRecordFolder).toHaveBeenCalledWith('record-1')
    expect(window.electronAPI.previewScreenDocRecord).toHaveBeenCalledWith('record-1')
    expect(window.electronAPI.exportScreenDocRecord).toHaveBeenCalledWith('record-1')
    expect(window.electronAPI.deleteScreenDocRecord).toHaveBeenCalledWith('record-1')
    expect(window.electronAPI.cancelScreenDoc).toHaveBeenCalledTimes(1)
    expect(window.electronAPI.reanalyzeScreenDocRecord).toHaveBeenCalledWith('record-3')
  })
})
