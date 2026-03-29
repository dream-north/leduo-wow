import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AppConfig,
  AssistantOutputMode,
  InputMethod,
  PolishPreset,
  ExcludedApp,
  ApiProvider,
  ShortcutServiceStatus,
  UpdateStatusPayload,
  VocabularyEntry,
  SharedVocabSyncSource,
  VocabMergeItem,
  VocabMergePreview,
  ScreenDocHistoryRecord,
  ScreenDocResultPayload,
  ScreenDocStatusPayload
} from '../../../shared/types'
import {
  BUILTIN_PRESETS,
  ASSISTANT_BUILTIN_PRESETS,
  SCREEN_DOC_BUILTIN_PRESETS,
  SCREEN_DOC_DEFAULT_PROMPT,
  VOCAB_PROMPT_BUILTIN_PRESETS,
  VOCAB_PROMPT_DEFAULT_TEMPLATE,
  ASR_DEFAULT_BASE_URL,
  POLISH_DEFAULT_BASE_URL,
  getDefaultAssistantShortcut,
  getDefaultTranscriptionShortcut
} from '../../../shared/types'
import { getRendererPlatform } from '../utils/platform'

declare global {
  interface Window {
    electronAPI: {
      platform: 'darwin' | 'win32' | 'linux'
      getConfig: () => Promise<AppConfig>
      getConfigValue: (key: string) => Promise<unknown>
      setConfig: (key: string, value: unknown) => Promise<boolean>
      checkPermissions: () => Promise<{ microphone: boolean; accessibility: boolean; screen: boolean }>
      requestPermission: (type: string) => Promise<boolean>
      getShortcutStatus: () => Promise<ShortcutServiceStatus>
      refreshShortcutStatus: () => Promise<ShortcutServiceStatus>
      ensureNativeBackendReady: () => Promise<boolean>
      setShortcutCaptureActive: (active: boolean) => Promise<boolean>
      onPipelineStatus: (callback: (status: string) => void) => () => void
      onPartialText: (callback: (text: string) => void) => () => void
      onFinalText: (callback: (text: string) => void) => () => void
      onError: (callback: (error: string) => void) => () => void
      onShortcutStatusChanged: (callback: (status: ShortcutServiceStatus) => void) => () => void
      getVersion: () => Promise<string>
      getHistory: () => Promise<Array<{
        id: string
        timestamp: number
        originalText: string
        polishedText: string
      }>>
      selectFolder: () => Promise<string>
      openPath: (path: string) => Promise<string>
      getRunningApps: () => Promise<Array<{ name: string; bundleId: string }>>
      onDockUpdateLock: (callback: (locked: boolean) => void) => () => void
      onHistoryUpdated: (callback: () => void) => () => void
      checkForUpdate: () => Promise<UpdateStatusPayload>
      downloadUpdate: () => Promise<void>
      installUpdate: () => Promise<void>
      getUpdateStatus: () => Promise<UpdateStatusPayload>
      onUpdateStatus: (callback: (payload: UpdateStatusPayload) => void) => () => void
      startScreenDoc: () => Promise<{ ok: boolean; error?: string }>
      getScreenDocStatus: () => Promise<ScreenDocStatusPayload>
      stopScreenDoc: () => Promise<ScreenDocResultPayload | null>
      cancelScreenDoc: () => Promise<boolean>
      sendScreenDocAudioChunk: (chunk: ArrayBuffer) => void
      getScreenDocHistory: () => Promise<ScreenDocHistoryRecord[]>
      getScreenDocHistoryRecord: (recordId: string) => Promise<ScreenDocHistoryRecord | null>
      exportScreenDocRecord: (recordId: string) => Promise<string | null>
      onScreenDocHistoryUpdated: (callback: () => void) => () => void
      getLatestScreenDocResult: () => Promise<ScreenDocResultPayload | null>
      onScreenDocStatus: (callback: (payload: ScreenDocStatusPayload) => void) => () => void
      // Vocabulary
      getPersonalVocabulary: () => Promise<VocabularyEntry[]>
      getSharedVocabulary: () => Promise<VocabularyEntry[]>
      addVocabulary: (
        source: string,
        entry: { term: string; description?: string; category?: string }
      ) => Promise<{ entry: VocabularyEntry; duplicate: boolean }>
      updateVocabulary: (
        source: string,
        id: string,
        updates: Record<string, unknown>
      ) => Promise<boolean>
      deleteVocabulary: (source: string, id: string) => Promise<boolean>
      importVocabulary: (
        source: string,
        entries: Array<{ term: string; description?: string; category?: string }>
      ) => Promise<{ added: number; skipped: number }>
      exportVocabulary: (source: string, name?: string) => Promise<{
        version: number
        name?: string
        exportedAt: number
        entries: Array<{ term: string; description: string; category: string }>
      }>
      getVocabularyStats: () => Promise<{
        personalCount: number
        sharedCount: number
        activeCount: number
      }>
      syncSharedVocabulary: () => Promise<{ synced: number; error?: string }>
      syncVocabularyFromUrl: (
        url: string,
        token?: string
      ) => Promise<{
        total: number
        name?: string
        error?: string
      }>
      removeVocabularySource: (sourceUrl: string) => Promise<void>
      previewMerge: (sourceUrl: string) => Promise<VocabMergePreview & { error?: string }>
      executeMerge: (
        sourceUrl: string,
        resolvedItems: VocabMergeItem[]
      ) => Promise<{ success: boolean; error?: string }>
      testWriteToken: (
        sourceUrl: string,
        token: string
      ) => Promise<{ success: boolean; error?: string }>
      onVocabularyUpdated: (callback: () => void) => () => void
    }
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const platform = getRendererPlatform()
  const defaultTranscriptionShortcut = getDefaultTranscriptionShortcut(platform)
  const defaultAssistantShortcut = getDefaultAssistantShortcut(platform)
  const normalizeInputMethod = (method: InputMethod): InputMethod => {
    if (platform !== 'darwin' && method === 'applescript') {
      return 'clipboard'
    }

    return method
  }

  const apiKey = ref('')
  const shortcut = ref('Alt+Space')
  const inputMethod = ref<InputMethod>('clipboard')
  // ASR
  const asrProvider = ref<ApiProvider>('dashscope')
  const asrApiKey = ref('')
  const asrBaseUrl = ref(ASR_DEFAULT_BASE_URL)
  const asrModel = ref('qwen3-asr-flash-realtime')
  // Polish
  const polishEnabled = ref(true)
  const polishProvider = ref<ApiProvider>('dashscope')
  const polishApiKey = ref('')
  const polishModel = ref('qwen3.5-flash')
  const polishBaseUrl = ref(POLISH_DEFAULT_BASE_URL)
  const polishPrompt = ref('')
  const polishPresets = ref<PolishPreset[]>([...BUILTIN_PRESETS])
  const activePresetIndex = ref(0)
  const selectedMicrophoneId = ref('')
  const launchAtLogin = ref(false)
  const overlayPosition = ref<'bottom' | 'cursor'>('bottom')
  const audioThreshold = ref(0)
  const screenshotEnabled = ref(false)
  const screenshotSavePath = ref('')
  const screenshotMaxCount = ref(30)
  const screenshotExcludedApps = ref<ExcludedApp[]>([])
  const hideDockIcon = ref(false)
  const historyMaxCount = ref(50)
  const loading = ref(false)
  // 双模式配置 - 语音识别
  const transcriptionShortcut = ref(defaultTranscriptionShortcut)
  const transcriptionEnabled = ref(true)
  // 双模式配置 - 语音助手
  const assistantShortcut = ref(defaultAssistantShortcut)
  const assistantEnabled = ref(true)
  const assistantPrePolish = ref(true)
  const assistantOutputMode = ref<AssistantOutputMode>('window')
  const assistantModel = ref('qwen3.5-flash')
  const assistantEnableThinking = ref(false)
  const assistantThinkingBudget = ref(256)
  const assistantEnableSearch = ref(false)
  const assistantEnableCodeInterpreter = ref(false)
  const assistantPrompt = ref('')
  const assistantPresets = ref<PolishPreset[]>([...ASSISTANT_BUILTIN_PRESETS])
  const assistantActivePresetIndex = ref(0)
  const screenDocPrompt = ref(SCREEN_DOC_DEFAULT_PROMPT)
  const screenDocPresets = ref<PolishPreset[]>([...SCREEN_DOC_BUILTIN_PRESETS])
  const screenDocActivePresetIndex = ref(0)
  const screenDocHistoryMaxCount = ref(20)
  // Vocabulary enhancement
  const vocabularyEnabled = ref(true)
  const vocabularyModel = ref('qwen3-asr-flash')
  const vocabularyPrompt = ref(VOCAB_PROMPT_DEFAULT_TEMPLATE)
  const vocabularyPromptPresets = ref<PolishPreset[]>([...VOCAB_PROMPT_BUILTIN_PRESETS])
  const vocabularyPromptActivePresetIndex = ref(0)
  const vocabularyInPolish = ref(false)
  const sharedVocabularySyncUrl = ref('')
  const sharedVocabularySyncToken = ref('')
  const customModels = ref<{ asr: string[]; text: string[]; vocab: string[] }>({ asr: [], text: [], vocab: [] })
  const customVocabularyCategories = ref<string[]>([])
  const sharedVocabSyncSources = ref<SharedVocabSyncSource[]>([])

  async function loadSettings(): Promise<void> {
    loading.value = true
    try {
      const config = await window.electronAPI.getConfig()
      apiKey.value = config.apiKey
      shortcut.value = config.shortcut
      inputMethod.value = normalizeInputMethod(config.inputMethod)
      // ASR
      asrProvider.value = config.asrProvider ?? 'dashscope'
      asrApiKey.value = config.asrApiKey ?? ''
      asrBaseUrl.value = config.asrBaseUrl ?? ASR_DEFAULT_BASE_URL
      asrModel.value = config.asrModel
      // Polish
      polishEnabled.value = config.polishEnabled
      polishProvider.value = config.polishProvider ?? 'dashscope'
      polishApiKey.value = config.polishApiKey ?? ''
      polishModel.value = config.polishModel
      polishBaseUrl.value = config.polishBaseUrl ?? POLISH_DEFAULT_BASE_URL
      polishPrompt.value = config.polishPrompt
      polishPresets.value = config.polishPresets ?? [...BUILTIN_PRESETS]
      activePresetIndex.value = config.activePresetIndex ?? 0
      selectedMicrophoneId.value = config.selectedMicrophoneId ?? ''
      launchAtLogin.value = config.launchAtLogin
      overlayPosition.value = config.overlayPosition
      audioThreshold.value = config.audioThreshold ?? 0
      screenshotEnabled.value = config.screenshotEnabled ?? false
      screenshotSavePath.value = config.screenshotSavePath ?? ''
      screenshotMaxCount.value = config.screenshotMaxCount ?? 30
      screenshotExcludedApps.value = config.screenshotExcludedApps ?? []
      hideDockIcon.value = config.hideDockIcon ?? false
      historyMaxCount.value = config.historyMaxCount ?? 50
      // 双模式配置 - 语音识别
      transcriptionShortcut.value = config.transcriptionShortcut ?? config.shortcut ?? defaultTranscriptionShortcut
      transcriptionEnabled.value = config.transcriptionEnabled ?? true
      // 双模式配置 - 语音助手
      assistantShortcut.value = config.assistantShortcut ?? defaultAssistantShortcut
      assistantEnabled.value = config.assistantEnabled ?? true
      assistantPrePolish.value = config.assistantPrePolish ?? true
      assistantOutputMode.value = config.assistantOutputMode ?? 'window'
      assistantModel.value = config.assistantModel ?? config.polishModel ?? 'qwen3.5-flash'
      assistantEnableThinking.value = config.assistantEnableThinking ?? false
      assistantThinkingBudget.value = config.assistantThinkingBudget ?? 256
      assistantEnableSearch.value = config.assistantEnableSearch ?? false
      assistantEnableCodeInterpreter.value = config.assistantEnableCodeInterpreter ?? false
      assistantPrompt.value = config.assistantPrompt ?? ''
      assistantPresets.value = config.assistantPresets ?? [...ASSISTANT_BUILTIN_PRESETS]
      assistantActivePresetIndex.value = config.assistantActivePresetIndex ?? 0
      screenDocPrompt.value = config.screenDocPrompt ?? SCREEN_DOC_DEFAULT_PROMPT
      screenDocPresets.value = config.screenDocPresets ?? [...SCREEN_DOC_BUILTIN_PRESETS]
      screenDocActivePresetIndex.value = config.screenDocActivePresetIndex ?? 0
      screenDocHistoryMaxCount.value = config.screenDocHistoryMaxCount ?? 20
      // Custom models (guard against old string[] format)
      const cm = config.customModels as unknown
      customModels.value = (cm && typeof cm === 'object' && !Array.isArray(cm) && 'asr' in (cm as Record<string, unknown>))
        ? cm as { asr: string[]; text: string[]; vocab: string[] }
        : { asr: [], text: [], vocab: [] }
      // Shared vocab sync sources
      sharedVocabSyncSources.value = config.sharedVocabSyncSources ?? []
      customVocabularyCategories.value = config.customVocabularyCategories ?? []
      // Vocabulary prompt
      vocabularyPrompt.value = config.vocabularyPrompt ?? VOCAB_PROMPT_DEFAULT_TEMPLATE
      vocabularyPromptPresets.value = config.vocabularyPromptPresets ?? [...VOCAB_PROMPT_BUILTIN_PRESETS]
      vocabularyPromptActivePresetIndex.value = config.vocabularyPromptActivePresetIndex ?? 0
      vocabularyInPolish.value = config.vocabularyInPolish ?? false
    } catch (err) {
      console.error('Failed to load settings:', err)
    } finally {
      loading.value = false
    }
  }

  async function saveSetting(key: string, value: unknown): Promise<void> {
    try {
      // Strip Vue reactivity proxy before sending through Electron IPC
      const plainValue = key === 'inputMethod'
        ? normalizeInputMethod(JSON.parse(JSON.stringify(value)))
        : JSON.parse(JSON.stringify(value))
      await window.electronAPI.setConfig(key, plainValue)
    } catch (err) {
      console.error(`Failed to save setting ${key}:`, err)
    }
  }

  return {
    apiKey,
    shortcut,
    inputMethod,
    // ASR
    asrProvider,
    asrApiKey,
    asrBaseUrl,
    asrModel,
    // Polish
    polishEnabled,
    polishProvider,
    polishApiKey,
    polishModel,
    polishBaseUrl,
    polishPrompt,
    polishPresets,
    activePresetIndex,
    selectedMicrophoneId,
    launchAtLogin,
    overlayPosition,
    audioThreshold,
    screenshotEnabled,
    screenshotSavePath,
    screenshotMaxCount,
    screenshotExcludedApps,
    hideDockIcon,
    historyMaxCount,
    loading,
    // 双模式配置 - 语音识别
    transcriptionShortcut,
    transcriptionEnabled,
    // 双模式配置 - 语音助手
    assistantShortcut,
    assistantEnabled,
    assistantPrePolish,
    assistantOutputMode,
    assistantModel,
    assistantEnableThinking,
    assistantThinkingBudget,
    assistantEnableSearch,
    assistantEnableCodeInterpreter,
    assistantPrompt,
    assistantPresets,
    assistantActivePresetIndex,
    screenDocPrompt,
    screenDocPresets,
    screenDocActivePresetIndex,
    screenDocHistoryMaxCount,
    // Vocabulary enhancement
    vocabularyEnabled,
    vocabularyModel,
    vocabularyPrompt,
    vocabularyPromptPresets,
    vocabularyPromptActivePresetIndex,
    vocabularyInPolish,
    sharedVocabularySyncUrl,
    sharedVocabularySyncToken,
    customModels,
    customVocabularyCategories,
    sharedVocabSyncSources,
    loadSettings,
    saveSetting
  }
})
