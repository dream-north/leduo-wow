import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSettingsStore } from './settings'

describe('settings store assistant output mode', () => {
  beforeEach(() => {
    setActivePinia(createPinia())

    window.electronAPI = {
      getConfig: vi.fn(async () => ({
        apiKey: '',
        shortcut: 'RightCommand',
        inputMethod: 'clipboard',
        asrProvider: 'dashscope',
        asrApiKey: '',
        asrBaseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
        asrModel: 'qwen3-asr-flash-realtime',
        polishEnabled: true,
        polishProvider: 'dashscope',
        polishApiKey: '',
        polishModel: 'qwen3.5-flash',
        polishBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        polishPrompt: '',
        polishPresets: [],
        activePresetIndex: 0,
        transcriptionShortcut: 'RightCommand',
        transcriptionEnabled: true,
        assistantShortcut: 'RightOption',
        assistantEnabled: true,
        assistantPrePolish: false,
        assistantOutputMode: 'window',
        assistantPrompt: '',
        assistantPresets: [],
        assistantActivePresetIndex: 0,
        launchAtLogin: false,
        selectedMicrophoneId: '',
        overlayPosition: 'bottom',
        audioThreshold: 0,
        screenshotEnabled: false,
        screenshotSavePath: '',
        screenshotMaxCount: 30,
        screenshotExcludedApps: [],
        hideDockIcon: false,
        historyMaxCount: 50
      })),
      setConfig: vi.fn(async () => true)
    } as never
  })

  it('loads assistant output mode from config', async () => {
    const store = useSettingsStore()

    await store.loadSettings()

    expect(store.assistantOutputMode).toBe('window')
  })

  it('persists assistant output mode changes through saveSetting', async () => {
    const store = useSettingsStore()

    await store.saveSetting('assistantOutputMode', 'window')

    expect(window.electronAPI.setConfig).toHaveBeenCalledWith('assistantOutputMode', 'window')
  })
})
