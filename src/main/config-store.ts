import Store from 'electron-store'
import { BrowserWindow } from 'electron'
import {
  AppConfig,
  DEFAULT_CONFIG,
  PolishPreset,
  ExcludedApp,
  ApiProvider,
  AssistantOutputMode,
  OverlayWindowPosition,
  OverlayWindowSize,
  getDefaultAssistantShortcut,
  getDefaultTranscriptionShortcut
} from '../shared/types'
import { IPC } from '../shared/ipc-channels'

interface StoreSchema {
  // Legacy (kept for migration from encrypted storage)
  apiKeyEncrypted: string
  apiKeyPlain: string
  // ASR
  asrProvider: ApiProvider
  asrApiKey: string
  asrBaseUrl: string
  asrModel: string
  // Polish (语音识别模式)
  polishProvider: ApiProvider
  polishApiKey: string
  polishModel: string
  polishBaseUrl: string
  polishEnabled: boolean
  polishPrompt: string
  polishPresets: PolishPreset[]
  activePresetIndex: number
  // 双模式配置 - 语音识别
  transcriptionShortcut: string
  transcriptionEnabled: boolean
  // 双模式配置 - 语音助手
  assistantShortcut: string
  assistantEnabled: boolean
  assistantPrePolish: boolean
  assistantOutputMode: AssistantOutputMode
  assistantModel: string
  assistantEnableThinking: boolean
  assistantThinkingBudget: number
  assistantEnableSearch: boolean
  assistantEnableCodeInterpreter: boolean
  assistantPrompt: string
  assistantPresets: PolishPreset[]
  assistantActivePresetIndex: number
  assistantResultWindowPosition?: OverlayWindowPosition
  assistantResultWindowSize?: OverlayWindowSize
  // General
  shortcut: string
  inputMethod: 'clipboard' | 'applescript'
  selectedMicrophoneId: string
  launchAtLogin: boolean
  overlayPosition: 'bottom' | 'cursor'
  audioThreshold: number
  screenshotEnabled: boolean
  screenshotSavePath: string
  screenshotMaxCount: number
  screenshotExcludedApps: ExcludedApp[]
  hideDockIcon: boolean
  historyMaxCount: number
  // Vocabulary enhancement
  vocabularyEnabled: boolean
  vocabularyModel: string
  vocabularyPrompt: string
  vocabularyPromptPresets: PolishPreset[]
  vocabularyPromptActivePresetIndex: number
  vocabularyInPolish: boolean
  sharedVocabularySyncUrl: string
  sharedVocabularySyncToken: string
  customModels: { asr: string[]; text: string[]; vocab: string[] }
  customVocabularyCategories: string[]
}

interface HistorySchema {
  records: Array<{
    id: string
    timestamp: number
    originalText: string
    polishedText: string
    mode?: 'transcription' | 'assistant'
  }>
}

let store: Store<StoreSchema>
let historyStore: Store<HistorySchema>

function normalizeInputMethod(
  method: StoreSchema['inputMethod'] | undefined,
  platform: NodeJS.Platform = process.platform
): StoreSchema['inputMethod'] {
  if (platform !== 'darwin') {
    return 'clipboard'
  }

  return method === 'applescript' ? 'applescript' : 'clipboard'
}

export function initConfigStore(): Store<StoreSchema> {
  const transcriptionShortcutDefault = getDefaultTranscriptionShortcut(process.platform)
  const assistantShortcutDefault = getDefaultAssistantShortcut(process.platform)

  store = new Store<StoreSchema>({
    name: 'config',
    defaults: {
      // Legacy
      apiKeyEncrypted: '',
      apiKeyPlain: '',
      // ASR
      asrProvider: DEFAULT_CONFIG.asrProvider,
      asrApiKey: '',
      asrBaseUrl: DEFAULT_CONFIG.asrBaseUrl,
      asrModel: DEFAULT_CONFIG.asrModel,
      // Polish (语音识别模式)
      polishProvider: DEFAULT_CONFIG.polishProvider,
      polishApiKey: '',
      polishModel: DEFAULT_CONFIG.polishModel,
      polishBaseUrl: DEFAULT_CONFIG.polishBaseUrl,
      polishEnabled: DEFAULT_CONFIG.polishEnabled,
      polishPrompt: DEFAULT_CONFIG.polishPrompt,
      polishPresets: DEFAULT_CONFIG.polishPresets,
      activePresetIndex: DEFAULT_CONFIG.activePresetIndex,
      // 双模式配置 - 语音识别
      transcriptionShortcut: transcriptionShortcutDefault,
      transcriptionEnabled: DEFAULT_CONFIG.transcriptionEnabled,
      // 双模式配置 - 语音助手
      assistantShortcut: assistantShortcutDefault,
      assistantEnabled: DEFAULT_CONFIG.assistantEnabled,
      assistantPrePolish: DEFAULT_CONFIG.assistantPrePolish,
      assistantOutputMode: DEFAULT_CONFIG.assistantOutputMode,
      assistantModel: DEFAULT_CONFIG.assistantModel,
      assistantEnableThinking: DEFAULT_CONFIG.assistantEnableThinking,
      assistantThinkingBudget: DEFAULT_CONFIG.assistantThinkingBudget,
      assistantEnableSearch: DEFAULT_CONFIG.assistantEnableSearch,
      assistantEnableCodeInterpreter: DEFAULT_CONFIG.assistantEnableCodeInterpreter,
      assistantPrompt: DEFAULT_CONFIG.assistantPrompt,
      assistantPresets: DEFAULT_CONFIG.assistantPresets,
      assistantActivePresetIndex: DEFAULT_CONFIG.assistantActivePresetIndex,
      assistantResultWindowPosition: DEFAULT_CONFIG.assistantResultWindowPosition,
      assistantResultWindowSize: DEFAULT_CONFIG.assistantResultWindowSize,
      // General
      shortcut: transcriptionShortcutDefault,
      inputMethod: DEFAULT_CONFIG.inputMethod,
      selectedMicrophoneId: DEFAULT_CONFIG.selectedMicrophoneId,
      launchAtLogin: DEFAULT_CONFIG.launchAtLogin,
      overlayPosition: DEFAULT_CONFIG.overlayPosition,
      audioThreshold: DEFAULT_CONFIG.audioThreshold,
      screenshotEnabled: DEFAULT_CONFIG.screenshotEnabled,
      screenshotSavePath: DEFAULT_CONFIG.screenshotSavePath,
      screenshotMaxCount: DEFAULT_CONFIG.screenshotMaxCount,
      screenshotExcludedApps: DEFAULT_CONFIG.screenshotExcludedApps,
      hideDockIcon: DEFAULT_CONFIG.hideDockIcon,
      historyMaxCount: DEFAULT_CONFIG.historyMaxCount,
      // Vocabulary enhancement
      vocabularyEnabled: DEFAULT_CONFIG.vocabularyEnabled,
      vocabularyModel: DEFAULT_CONFIG.vocabularyModel,
      vocabularyPrompt: DEFAULT_CONFIG.vocabularyPrompt,
      vocabularyPromptPresets: DEFAULT_CONFIG.vocabularyPromptPresets,
      vocabularyPromptActivePresetIndex: DEFAULT_CONFIG.vocabularyPromptActivePresetIndex,
      vocabularyInPolish: DEFAULT_CONFIG.vocabularyInPolish,
      sharedVocabularySyncUrl: DEFAULT_CONFIG.sharedVocabularySyncUrl,
      sharedVocabularySyncToken: DEFAULT_CONFIG.sharedVocabularySyncToken,
      customModels: { asr: [], text: [], vocab: [] },
      customVocabularyCategories: []
    }
  })

  historyStore = new Store<HistorySchema>({
    name: 'history',
    defaults: {
      records: []
    }
  })

  // Migrate: move history from config.json to history.json if exists
  const oldHistory = (store as any).get('history')
  if (Array.isArray(oldHistory) && oldHistory.length > 0) {
    historyStore.set('records', oldHistory)
    ;(store as any).delete('history')
    console.log(`[ConfigStore] Migrated ${oldHistory.length} history records to history.json`)
  }

  return store
}

function readLegacyEncryptedKey(s: Store<StoreSchema>): string {
  // 旧版本使用 safeStorage 加密存储，现在已改用明文存储
  // 如果用户还有未迁移的旧数据，手动在设置中重新输入 API key 即可
  return (s.get('apiKeyPlain') as string) || ''
}

export function getConfig(s: Store<StoreSchema>): AppConfig {
  const transcriptionShortcutDefault = getDefaultTranscriptionShortcut(process.platform)
  const assistantShortcutDefault = getDefaultAssistantShortcut(process.platform)

  // Read new plaintext keys
  let asrApiKey = (s.get('asrApiKey') as string) || ''
  let polishApiKey = (s.get('polishApiKey') as string) || ''

  // Migration: from legacy encrypted apiKey to new plaintext fields
  if (!asrApiKey && !polishApiKey) {
    const legacyApiKey = readLegacyEncryptedKey(s)
    if (legacyApiKey) {
      console.log('[ConfigStore] Migrating legacy encrypted apiKey to plaintext asrApiKey + polishApiKey')
      s.set('asrApiKey', legacyApiKey as never)
      s.set('polishApiKey', legacyApiKey as never)
      // Clear legacy fields
      s.set('apiKeyEncrypted', '' as never)
      s.set('apiKeyPlain', '' as never)
      asrApiKey = legacyApiKey
      polishApiKey = legacyApiKey
    }
  }

  // Migration: from old shortcut to transcriptionShortcut
  const oldShortcut = s.get('shortcut')
  if (oldShortcut && !s.get('transcriptionShortcut')) {
    s.set('transcriptionShortcut', oldShortcut as never)
    console.log('[ConfigStore] Migrated shortcut to transcriptionShortcut:', oldShortcut)
  }

  return {
    apiKey: '',
    shortcut: s.get('shortcut'),
    inputMethod: normalizeInputMethod(s.get('inputMethod')),
    // ASR
    asrProvider: s.get('asrProvider') ?? DEFAULT_CONFIG.asrProvider,
    asrApiKey,
    asrBaseUrl: s.get('asrBaseUrl') ?? DEFAULT_CONFIG.asrBaseUrl,
    asrModel: s.get('asrModel'),
    // Polish (语音识别模式)
    polishEnabled: s.get('polishEnabled'),
    polishProvider: s.get('polishProvider') ?? DEFAULT_CONFIG.polishProvider,
    polishApiKey,
    polishModel: s.get('polishModel'),
    polishBaseUrl: s.get('polishBaseUrl') ?? DEFAULT_CONFIG.polishBaseUrl,
    polishPrompt: s.get('polishPrompt'),
    polishPresets: s.get('polishPresets') ?? DEFAULT_CONFIG.polishPresets,
    activePresetIndex: s.get('activePresetIndex') ?? 0,
    // 双模式配置 - 语音识别
    transcriptionShortcut: s.get('transcriptionShortcut') ?? s.get('shortcut') ?? transcriptionShortcutDefault,
    transcriptionEnabled: s.get('transcriptionEnabled') ?? DEFAULT_CONFIG.transcriptionEnabled,
    // 双模式配置 - 语音助手
    assistantShortcut: s.get('assistantShortcut') ?? assistantShortcutDefault,
    assistantEnabled: s.get('assistantEnabled') ?? DEFAULT_CONFIG.assistantEnabled,
    assistantPrePolish: s.get('assistantPrePolish') ?? DEFAULT_CONFIG.assistantPrePolish,
    assistantOutputMode: s.get('assistantOutputMode') ?? DEFAULT_CONFIG.assistantOutputMode,
    assistantModel: s.get('assistantModel') ?? s.get('polishModel') ?? DEFAULT_CONFIG.assistantModel,
    assistantEnableThinking: s.get('assistantEnableThinking') ?? DEFAULT_CONFIG.assistantEnableThinking,
    assistantThinkingBudget: s.get('assistantThinkingBudget') ?? DEFAULT_CONFIG.assistantThinkingBudget,
    assistantEnableSearch: s.get('assistantEnableSearch') ?? DEFAULT_CONFIG.assistantEnableSearch,
    assistantEnableCodeInterpreter: s.get('assistantEnableCodeInterpreter') ?? DEFAULT_CONFIG.assistantEnableCodeInterpreter,
    assistantPrompt: s.get('assistantPrompt') ?? DEFAULT_CONFIG.assistantPrompt,
    assistantPresets: s.get('assistantPresets') ?? DEFAULT_CONFIG.assistantPresets,
    assistantActivePresetIndex: s.get('assistantActivePresetIndex') ?? DEFAULT_CONFIG.assistantActivePresetIndex,
    assistantResultWindowPosition: s.get('assistantResultWindowPosition') ?? DEFAULT_CONFIG.assistantResultWindowPosition,
    assistantResultWindowSize: s.get('assistantResultWindowSize') ?? DEFAULT_CONFIG.assistantResultWindowSize,
    // General
    selectedMicrophoneId: s.get('selectedMicrophoneId') ?? '',
    launchAtLogin: s.get('launchAtLogin'),
    overlayPosition: s.get('overlayPosition'),
    audioThreshold: s.get('audioThreshold'),
    screenshotEnabled: s.get('screenshotEnabled') ?? false,
    screenshotSavePath: s.get('screenshotSavePath') ?? '',
    screenshotMaxCount: s.get('screenshotMaxCount') ?? 30,
    screenshotExcludedApps: s.get('screenshotExcludedApps') ?? [],
    hideDockIcon: s.get('hideDockIcon') ?? false,
    historyMaxCount: s.get('historyMaxCount') ?? 50,
    // Vocabulary enhancement
    vocabularyEnabled: s.get('vocabularyEnabled') ?? DEFAULT_CONFIG.vocabularyEnabled,
    vocabularyModel: s.get('vocabularyModel') ?? DEFAULT_CONFIG.vocabularyModel,
    vocabularyPrompt: s.get('vocabularyPrompt') ?? DEFAULT_CONFIG.vocabularyPrompt,
    vocabularyPromptPresets: s.get('vocabularyPromptPresets') ?? DEFAULT_CONFIG.vocabularyPromptPresets,
    vocabularyPromptActivePresetIndex: s.get('vocabularyPromptActivePresetIndex') ?? DEFAULT_CONFIG.vocabularyPromptActivePresetIndex,
    vocabularyInPolish: s.get('vocabularyInPolish') ?? DEFAULT_CONFIG.vocabularyInPolish,
    sharedVocabularySyncUrl: s.get('sharedVocabularySyncUrl') ?? DEFAULT_CONFIG.sharedVocabularySyncUrl,
    sharedVocabularySyncToken: s.get('sharedVocabularySyncToken') ?? DEFAULT_CONFIG.sharedVocabularySyncToken,
    sharedVocabSyncSources: (() => {
      const saved = s.get('sharedVocabSyncSources')
      if (Array.isArray(saved) && saved.length > 0) return saved
      // Migrate: if old single URL exists, convert to source
      const legacyUrl = s.get('sharedVocabularySyncUrl')
      if (legacyUrl) {
        const migrated = [{ name: '共享词典', url: legacyUrl }]
        s.set('sharedVocabSyncSources', migrated as never)
        return migrated
      }
      return []
    })(),
    customModels: (() => {
      const raw = s.get('customModels')
      return (raw && typeof raw === 'object' && !Array.isArray(raw))
        ? raw as { asr: string[]; text: string[]; vocab: string[] }
        : { asr: [], text: [], vocab: [] }
    })(),
    customVocabularyCategories: (s.get('customVocabularyCategories') ?? []) as string[]
  }
}

export function setConfig(
  s: Store<StoreSchema>,
  key: string,
  value: unknown
): void {
  if (key === 'inputMethod') {
    s.set('inputMethod', normalizeInputMethod(value as StoreSchema['inputMethod']) as never)
    console.log('Config saved: inputMethod')
    return
  }

  s.set(key as keyof StoreSchema, value as never)
  console.log(`Config saved: ${key}`)
}

export function getHistory(_s: Store<StoreSchema>) {
  return historyStore.get('records') || []
}

export function setHistory(_s: Store<StoreSchema>, records: Array<{ id: string; timestamp: number; originalText: string; polishedText: string }>) {
  historyStore.set('records', records)
}

export function addHistory(
  s: Store<StoreSchema>,
  record: { id: string; timestamp: number; originalText: string; polishedText: string; mode?: 'transcription' | 'assistant' }
) {
  const history = getHistory(s)
  history.unshift(record)
  const maxCount = s.get('historyMaxCount') ?? 50
  if (history.length > maxCount) history.pop()
  historyStore.set('records', history)

  // Notify all windows that history has been updated
  BrowserWindow.getAllWindows().forEach((win) => {
    win.webContents.send(IPC.HISTORY_UPDATED)
  })
}

export type ConfigStore = Store<StoreSchema>
