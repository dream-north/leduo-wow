<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../stores/settings'
import {
  BUILTIN_PRESETS,
  ASR_DEFAULT_BASE_URL,
  POLISH_DEFAULT_BASE_URL,
  ASSISTANT_DEFAULT_PROMPT,
  ASR_MODEL_PRESETS,
  TEXT_MODEL_PRESETS,
  FLASH_ASR_MODEL_PRESETS,
  VOCABULARY_CATEGORY_PRESETS,
  getDefaultAssistantShortcut,
  getDefaultTranscriptionShortcut
} from '../../../shared/types'
import { getRendererPlatform } from '../utils/platform'
import type {
  PolishPreset,
  ShortcutModeStatus,
  ShortcutServiceStatus,
  TranscriptionRecord,
  VoiceMode,
  UpdateStatusPayload,
  VocabularyEntry
} from '../../../shared/types'

const store = useSettingsStore()
const platform = getRendererPlatform()
const defaultTranscriptionShortcut = getDefaultTranscriptionShortcut(platform)
const defaultAssistantShortcut = getDefaultAssistantShortcut(platform)
const altKeyName = platform === 'win32' ? 'Alt' : 'Option'
const pasteShortcutLabel = platform === 'win32' ? 'Ctrl+V' : 'Cmd+V'
const showAppleScriptInputMethod = platform === 'darwin'
const showDockVisibilityToggle = platform === 'darwin'
const showAccessibilityPermission = platform === 'darwin'
const showScreenPermission = platform === 'darwin'
const initialTab = sessionStorage.getItem('settings-active-tab')
const activeTab = ref(initialTab === 'prompt' ? 'prompt-transcription' : (initialTab || 'general'))
const contentRef = ref<HTMLElement | null>(null)
const tabScrollPositions = new Map<string, number>()
const dockUpdateLocked = ref(false)
let unsubscribeDockLock: (() => void) | null = null
let unsubscribeHistoryUpdate: (() => void) | null = null
let unsubscribeVocabularyUpdate: (() => void) | null = null

// Vocabulary (Memory tab)
const personalVocabulary = ref<VocabularyEntry[]>([])
const sharedVocabulary = ref<VocabularyEntry[]>([])
const vocabStats = ref({ personalCount: 0, sharedCount: 0, activeCount: 0 })
const vocabSubTab = ref<'settings' | 'personal' | 'shared'>('settings')
const sharedSourceTabIndex = ref(0)
watch(vocabSubTab, () => { vocabFilterCategory.value = '全部'; sharedSourceTabIndex.value = 0 })
const vocabFilterCategory = ref('全部')
const vocabNewTerm = ref('')
const vocabNewDesc = ref('')
const vocabNewCategory = ref('其他')
const showVocabAddForm = ref(false)
const showSyncSourceForm = ref(false)
const syncSourceName = ref('')
const syncSourceUrl = ref('')
const exportName = ref('')
const showExportNameInput = ref(false)
const vocabEditingId = ref<string | null>(null)
const vocabEditTerm = ref('')
const vocabEditDesc = ref('')
const vocabEditCategory = ref('')
const vocabSyncLoading = ref(false)
const vocabSyncResult = ref('')
watch(activeTab, (val, oldVal) => {
  sessionStorage.setItem('settings-active-tab', val)
  // Save scroll position for old tab
  if (oldVal && contentRef.value) {
    tabScrollPositions.set(oldVal, contentRef.value.scrollTop)
  }
  // Restore scroll position for new tab
  nextTick(() => {
    if (contentRef.value) {
      contentRef.value.scrollTop = tabScrollPositions.get(val) || 0
    }
  })
})
const saveMessage = ref('')

const tabs = [
  { id: 'general', label: '通用', icon: '⚙️' },
  { id: 'api', label: 'API', icon: '🔑' },
  { id: 'prompt-transcription', label: '语音识别', icon: '🎤' },
  { id: 'prompt-assistant', label: '语音助手', icon: '🤖' },
  { id: 'memory', label: '记忆', icon: '🧠' },
  { id: 'history', label: '历史', icon: '📜' },
  { id: 'about', label: '关于', icon: 'ℹ️' }
]

function showSaveMessage(msg: string): void {
  saveMessage.value = msg
  setTimeout(() => { saveMessage.value = '' }, 2000)
}

// API Keys (separate for ASR and Polish)
const asrApiKeyVisible = ref(false)
const asrApiKeyInput = ref('')
const polishApiKeyVisible = ref(false)
const polishApiKeyInput = ref('')

async function saveAsrApiKey(): Promise<void> {
  if (asrApiKeyInput.value === store.asrApiKey) return
  await store.saveSetting('asrApiKey', asrApiKeyInput.value)
  store.asrApiKey = asrApiKeyInput.value
  showSaveMessage('语音识别 API Key 已自动保存')
}

async function savePolishApiKey(): Promise<void> {
  if (polishApiKeyInput.value === store.polishApiKey) return
  await store.saveSetting('polishApiKey', polishApiKeyInput.value)
  store.polishApiKey = polishApiKeyInput.value
  showSaveMessage('润色 API Key 已自动保存')
}

async function saveAsrBaseUrl(): Promise<void> {
  store.asrBaseUrl = store.asrBaseUrl.replace(/\/+$/, '')
  await store.saveSetting('asrBaseUrl', store.asrBaseUrl)
  showSaveMessage('语音识别接入点已保存')
}

async function resetAsrBaseUrl(): Promise<void> {
  store.asrBaseUrl = ASR_DEFAULT_BASE_URL
  await store.saveSetting('asrBaseUrl', ASR_DEFAULT_BASE_URL)
  showSaveMessage('已重置为百炼默认接入点')
}

async function resetPolishBaseUrl(): Promise<void> {
  store.polishBaseUrl = POLISH_DEFAULT_BASE_URL
  await store.saveSetting('polishBaseUrl', POLISH_DEFAULT_BASE_URL)
  showSaveMessage('已重置为百炼默认接入点')
}

// Shortcut - 双快捷键支持
const recordingShortcut = ref<'transcription' | 'assistant' | false>(false)
const shortcutDisplay = ref<string[]>([])
const pendingShortcut = ref('')  // Captured shortcut waiting to be saved
let shortcutKeyHandler: ((e: KeyboardEvent) => void) | null = null
let shortcutKeyUpHandler: ((e: KeyboardEvent) => void) | null = null
let capturedKeys: string[] = []  // Accumulated keys during shortcut recording
let shortcutCaptureSuspended = false

// Map e.code to a readable key name for Electron's globalShortcut
// On macOS, Alt+key produces special unicode chars in e.key (e.g. Alt+/ → «),
// so we must use e.code (physical key) instead.
// e.code includes side info: MetaLeft, MetaRight, AltLeft, AltRight, etc.
const codeToKey: Record<string, string> = {
  Space: 'Space', Backspace: 'Backspace', Enter: 'Return', Tab: 'Tab',
  Escape: 'Escape', Delete: 'Delete',
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
  Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Slash: '/', Backquote: '`',
  // Modifier keys with side info (for single-key shortcuts like RightCommand)
  MetaLeft: 'LeftCommand', MetaRight: 'RightCommand',
  ControlLeft: 'LeftControl', ControlRight: 'RightControl',
  AltLeft: `Left${altKeyName}`, AltRight: `Right${altKeyName}`,
  ShiftLeft: 'LeftShift', ShiftRight: 'RightShift',
}
function keyFromCode(code: string, fallbackKey: string): string {
  // e.code like "KeyA" → "A", "Digit1" → "1"
  if (code.startsWith('Key')) return code.slice(3)
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return 'num' + code.slice(6)
  if (code.startsWith('F') && /^F\d+$/.test(code)) return code // F1-F12
  if (codeToKey[code]) return codeToKey[code]
  // Fallback: normalize the original key
  if (fallbackKey === ' ' || fallbackKey === '\u00A0') return 'Space'
  return fallbackKey.charAt(0).toUpperCase() + fallbackKey.slice(1)
}

// Track modifier key sides for keyup detection
const modifierKeySides = new Map<string, 'Left' | 'Right'>()

function isModifierCode(code: string): boolean {
  return code === 'ControlLeft' || code === 'ControlRight' ||
         code === 'AltLeft' || code === 'AltRight' ||
         code === 'MetaLeft' || code === 'MetaRight' ||
         code === 'ShiftLeft' || code === 'ShiftRight'
}

function isValidShortcutText(shortcut: string): boolean {
  const parts = shortcut.split('+').map((part) => part.trim()).filter(Boolean)
  return parts.some((part) => /^(Left|Right)?(Command|Control|Option|Alt|Shift|Ctrl|Meta)$/.test(part))
}

function resetRecordingState(): void {
  modifierKeySides.clear()
  capturedKeys = []
  recordingShortcut.value = false
  pendingShortcut.value = ''
  shortcutDisplay.value = []
}

function handleShortcutKeyDown(e: KeyboardEvent): void {
  if (!recordingShortcut.value) return

  e.preventDefault()
  e.stopPropagation()
  if (e.repeat) return

  if (e.code === 'Escape' && capturedKeys.length === 0) {
    void cancelShortcut()
    return
  }

  if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
    modifierKeySides.set('Control', e.code === 'ControlLeft' ? 'Left' : 'Right')
  }
  if (e.code === 'AltLeft' || e.code === 'AltRight') {
    modifierKeySides.set('Alt', e.code === 'AltLeft' ? 'Left' : 'Right')
  }
  if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
    modifierKeySides.set('Meta', e.code === 'MetaLeft' ? 'Left' : 'Right')
  }
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    modifierKeySides.set('Shift', e.code === 'ShiftLeft' ? 'Left' : 'Right')
  }

  if (e.code === 'ControlLeft' || e.code === 'ControlRight') {
    capturedKeys.push(e.code === 'ControlLeft' ? 'LeftControl' : 'RightControl')
  } else if (e.ctrlKey) {
    const side = modifierKeySides.get('Control')
    capturedKeys.push(side ? (side === 'Left' ? 'LeftControl' : 'RightControl') : 'Ctrl')
  }

  if (e.code === 'AltLeft' || e.code === 'AltRight') {
    capturedKeys.push(e.code === 'AltLeft' ? `Left${altKeyName}` : `Right${altKeyName}`)
  } else if (e.altKey) {
    const side = modifierKeySides.get('Alt')
    capturedKeys.push(side ? (side === 'Left' ? `Left${altKeyName}` : `Right${altKeyName}`) : 'Alt')
  }

  if (e.code === 'MetaLeft' || e.code === 'MetaRight') {
    capturedKeys.push(e.code === 'MetaLeft' ? 'LeftCommand' : 'RightCommand')
  } else if (e.metaKey) {
    const side = modifierKeySides.get('Meta')
    capturedKeys.push(side ? (side === 'Left' ? 'LeftCommand' : 'RightCommand') : 'Command')
  }

  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
    capturedKeys.push(e.code === 'ShiftLeft' ? 'LeftShift' : 'RightShift')
  } else if (e.shiftKey) {
    const side = modifierKeySides.get('Shift')
    capturedKeys.push(side ? (side === 'Left' ? 'LeftShift' : 'RightShift') : 'Shift')
  }

  if (!isModifierCode(e.code)) {
    const normalizedKey = keyFromCode(e.code, e.key)
    capturedKeys.push(normalizedKey)

    const uniqueKeys = [...new Set(capturedKeys)]
    pendingShortcut.value = uniqueKeys.join('+')
    shortcutDisplay.value = uniqueKeys
    stopShortcutListeners()
  } else {
    const uniqueKeys = [...new Set(capturedKeys)]
    shortcutDisplay.value = uniqueKeys
    pendingShortcut.value = uniqueKeys.join('+')
  }
}

function handleShortcutKeyUp(e: KeyboardEvent): void {
  if (!recordingShortcut.value) return

  e.preventDefault()
  e.stopPropagation()

  if (isModifierCode(e.code)) {
    const uniqueKeys = [...new Set(capturedKeys)]
    if (uniqueKeys.length > 0) {
      pendingShortcut.value = uniqueKeys.join('+')
      shortcutDisplay.value = uniqueKeys
      stopShortcutListeners()
    }
    return
  }

  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) {
    const normalizedKey = keyFromCode(e.code, e.key)
    capturedKeys.push(normalizedKey)

    const uniqueKeys = [...new Set(capturedKeys)]
    if (uniqueKeys.length > 0) {
      pendingShortcut.value = uniqueKeys.join('+')
      shortcutDisplay.value = uniqueKeys
      stopShortcutListeners()
    }
  }
}

async function startRecordShortcut(mode: VoiceMode): Promise<void> {
  stopShortcutListeners()
  resetRecordingState()
  await window.electronAPI.setShortcutCaptureActive(true)
  shortcutCaptureSuspended = true
  recordingShortcut.value = mode
  shortcutKeyHandler = handleShortcutKeyDown
  shortcutKeyUpHandler = handleShortcutKeyUp
  window.addEventListener('keydown', shortcutKeyHandler, true)
  window.addEventListener('keyup', shortcutKeyUpHandler, true)
}

function stopShortcutListeners(): void {
  if (shortcutKeyHandler) {
    window.removeEventListener('keydown', shortcutKeyHandler, true)
    shortcutKeyHandler = null
  }
  if (shortcutKeyUpHandler) {
    window.removeEventListener('keyup', shortcutKeyUpHandler, true)
    shortcutKeyUpHandler = null
  }
}

async function confirmShortcut(): Promise<void> {
  if (!pendingShortcut.value || !recordingShortcut.value) return
  if (!isValidShortcutText(pendingShortcut.value)) {
    showSaveMessage('快捷键至少需要一个修饰键')
    return
  }

  const mode = recordingShortcut.value
  const key = mode === 'assistant' ? 'assistantShortcut' : 'transcriptionShortcut'
  await store.saveSetting(key, pendingShortcut.value)

  if (mode === 'assistant') {
    store.assistantShortcut = pendingShortcut.value
  } else {
    store.transcriptionShortcut = pendingShortcut.value
  }

  stopShortcutListeners()
  resetRecordingState()
  if (shortcutCaptureSuspended) {
    await window.electronAPI.setShortcutCaptureActive(false)
    shortcutCaptureSuspended = false
  }
  await window.electronAPI.refreshShortcutStatus()
  showSaveMessage('快捷键已保存')
}

async function cancelShortcut(): Promise<void> {
  stopShortcutListeners()
  resetRecordingState()
  if (shortcutCaptureSuspended) {
    await window.electronAPI.setShortcutCaptureActive(false)
    shortcutCaptureSuspended = false
  }
}

// Reset to default shortcut
async function resetShortcut(mode: VoiceMode): Promise<void> {
  const defaultShortcut = mode === 'assistant' ? defaultAssistantShortcut : defaultTranscriptionShortcut
  const key = mode === 'assistant' ? 'assistantShortcut' : 'transcriptionShortcut'
  await store.saveSetting(key, defaultShortcut)

  if (mode === 'assistant') {
    store.assistantShortcut = defaultShortcut
  } else {
    store.transcriptionShortcut = defaultShortcut
  }

  await window.electronAPI.refreshShortcutStatus()
  showSaveMessage('快捷键已重置为默认')
}

// Input method
async function setInputMethod(method: 'clipboard' | 'applescript'): Promise<void> {
  store.inputMethod = method
  await store.saveSetting('inputMethod', method)
  showSaveMessage('输入方式已保存')
}

// Polish toggle
async function togglePolish(): Promise<void> {
  store.polishEnabled = !store.polishEnabled
  await store.saveSetting('polishEnabled', store.polishEnabled)
}

// 双模式开关
async function toggleTranscription(): Promise<void> {
  store.transcriptionEnabled = !store.transcriptionEnabled
  await store.saveSetting('transcriptionEnabled', store.transcriptionEnabled)
}

async function toggleAssistant(): Promise<void> {
  store.assistantEnabled = !store.assistantEnabled
  await store.saveSetting('assistantEnabled', store.assistantEnabled)
}

async function toggleAssistantPrePolish(value: boolean): Promise<void> {
  store.assistantPrePolish = value
  await store.saveSetting('assistantPrePolish', value)
}

async function setAssistantOutputMode(mode: 'input' | 'window'): Promise<void> {
  store.assistantOutputMode = mode
  await store.saveSetting('assistantOutputMode', mode)
  showSaveMessage('助手输出方式已保存')
}

async function toggleAssistantThinking(): Promise<void> {
  if (store.assistantEnableCodeInterpreter) return
  store.assistantEnableThinking = !store.assistantEnableThinking
  await store.saveSetting('assistantEnableThinking', store.assistantEnableThinking)
  showSaveMessage('助手思考模式已更新')
}

async function saveAssistantThinkingBudget(event?: Event): Promise<void> {
  const nextValue = event
    ? parseInt((event.target as HTMLInputElement).value, 10)
    : store.assistantThinkingBudget
  const budget = Number.isFinite(nextValue) && nextValue > 0 ? nextValue : 256
  store.assistantThinkingBudget = budget
  await store.saveSetting('assistantThinkingBudget', budget)
  showSaveMessage('助手思考 Token 数已更新')
}

async function toggleAssistantSearch(): Promise<void> {
  store.assistantEnableSearch = !store.assistantEnableSearch
  await store.saveSetting('assistantEnableSearch', store.assistantEnableSearch)
  showSaveMessage('助手联网搜索已更新')
}

async function toggleAssistantCodeInterpreter(): Promise<void> {
  store.assistantEnableCodeInterpreter = !store.assistantEnableCodeInterpreter
  await store.saveSetting('assistantEnableCodeInterpreter', store.assistantEnableCodeInterpreter)
  if (store.assistantEnableCodeInterpreter && !store.assistantEnableThinking) {
    store.assistantEnableThinking = true
    await store.saveSetting('assistantEnableThinking', true)
  }
  showSaveMessage('助手 Python 解释器已更新')
}

// Screenshot toggle
async function toggleScreenshot(): Promise<void> {
  store.screenshotEnabled = !store.screenshotEnabled
  await store.saveSetting('screenshotEnabled', store.screenshotEnabled)
}

async function selectScreenshotFolder(): Promise<void> {
  const folder = await window.electronAPI.selectFolder()
  if (folder) {
    store.screenshotSavePath = folder
    await store.saveSetting('screenshotSavePath', folder)
    showSaveMessage('截图保存路径已设置')
  }
}

async function clearScreenshotFolder(): Promise<void> {
  store.screenshotSavePath = ''
  await store.saveSetting('screenshotSavePath', '')
  showSaveMessage('已清除截图保存路径')
}

async function openScreenshotFolder(): Promise<void> {
  if (store.screenshotSavePath) {
    await window.electronAPI.openPath(store.screenshotSavePath)
  }
}

async function updateScreenshotMaxCount(event: Event): Promise<void> {
  const val = parseInt((event.target as HTMLInputElement).value, 10)
  const count = isNaN(val) || val < 0 ? 0 : val
  store.screenshotMaxCount = count
  await store.saveSetting('screenshotMaxCount', count)
  showSaveMessage('截图保留数量已更新')
}

// Excluded apps
interface RunningApp { name: string; bundleId: string }
const runningApps = ref<RunningApp[]>([])
const selectedAppBundleId = ref('')

async function refreshRunningApps(): Promise<void> {
  const apps = await window.electronAPI.getRunningApps()
  const excludedIds = new Set(store.screenshotExcludedApps.map(a => a.bundleId))
  runningApps.value = apps.filter(a => !excludedIds.has(a.bundleId))
  selectedAppBundleId.value = ''
}

async function addExcludedApp(): Promise<void> {
  if (!selectedAppBundleId.value) return
  const app = runningApps.value.find(a => a.bundleId === selectedAppBundleId.value)
  if (!app) return
  store.screenshotExcludedApps = [...store.screenshotExcludedApps, { name: app.name, bundleId: app.bundleId }]
  await store.saveSetting('screenshotExcludedApps', store.screenshotExcludedApps)
  selectedAppBundleId.value = ''
  runningApps.value = runningApps.value.filter(a => a.bundleId !== app.bundleId)
  showSaveMessage(`已排除 ${app.name}`)
}

async function removeExcludedApp(bundleId: string): Promise<void> {
  store.screenshotExcludedApps = store.screenshotExcludedApps.filter(a => a.bundleId !== bundleId)
  await store.saveSetting('screenshotExcludedApps', store.screenshotExcludedApps)
  showSaveMessage('已移除')
}

// Polish prompt
async function savePolishPrompt(): Promise<void> {
  // Also update the active preset's prompt
  const idx = store.activePresetIndex
  if (idx >= 0 && idx < store.polishPresets.length) {
    store.polishPresets[idx].prompt = store.polishPrompt
    await store.saveSetting('polishPresets', store.polishPresets)
  }
  await store.saveSetting('polishPrompt', store.polishPrompt)
  showSaveMessage('提示词已保存')
}

// 语音助手提示词保存
async function saveAssistantPrompt(): Promise<void> {
  const idx = store.assistantActivePresetIndex
  if (idx >= 0 && idx < store.assistantPresets.length) {
    store.assistantPresets[idx].prompt = store.assistantPrompt
    await store.saveSetting('assistantPresets', store.assistantPresets)
  }
  await store.saveSetting('assistantPrompt', store.assistantPrompt)
  showSaveMessage('助手提示词已保存')
}

// 重置语音助手提示词为默认
async function resetAssistantPrompt(): Promise<void> {
  store.assistantPrompt = ASSISTANT_DEFAULT_PROMPT
  const idx = store.assistantActivePresetIndex
  if (idx >= 0 && idx < store.assistantPresets.length && store.assistantPresets[idx].builtIn) {
    store.assistantPresets[idx].prompt = ASSISTANT_DEFAULT_PROMPT
    await store.saveSetting('assistantPresets', store.assistantPresets)
  }
  await store.saveSetting('assistantPrompt', ASSISTANT_DEFAULT_PROMPT)
  showSaveMessage('提示词已重置为默认')
}

// 切换助手预设
async function switchAssistantPreset(index: number): Promise<void> {
  store.assistantActivePresetIndex = index
  store.assistantPrompt = store.assistantPresets[index].prompt
  await store.saveSetting('assistantActivePresetIndex', index)
  await store.saveSetting('assistantPrompt', store.assistantPrompt)
  showSaveMessage(`已切换到「${store.assistantPresets[index].name}」`)
}

// 添加助手预设
async function addAssistantPreset(): Promise<void> {
  const preset: PolishPreset = {
    name: `自定义助手 ${store.assistantPresets.filter(p => !p.builtIn).length + 1}`,
    prompt: ''
  }
  store.assistantPresets.push(preset)
  const newIndex = store.assistantPresets.length - 1
  store.assistantActivePresetIndex = newIndex
  store.assistantPrompt = preset.prompt
  await store.saveSetting('assistantPresets', store.assistantPresets)
  await store.saveSetting('assistantActivePresetIndex', newIndex)
  await store.saveSetting('assistantPrompt', '')
}

// Preset management
async function switchPreset(index: number): Promise<void> {
  store.activePresetIndex = index
  store.polishPrompt = store.polishPresets[index].prompt
  await store.saveSetting('activePresetIndex', index)
  await store.saveSetting('polishPrompt', store.polishPrompt)
  showSaveMessage(`已切换到「${store.polishPresets[index].name}」`)
}

async function addPreset(): Promise<void> {
  const preset: PolishPreset = {
    name: `自定义 ${store.polishPresets.filter(p => !p.builtIn).length + 1}`,
    prompt: ''
  }
  store.polishPresets.push(preset)
  const newIndex = store.polishPresets.length - 1
  store.activePresetIndex = newIndex
  store.polishPrompt = preset.prompt
  await store.saveSetting('polishPresets', store.polishPresets)
  await store.saveSetting('activePresetIndex', newIndex)
  await store.saveSetting('polishPrompt', '')
}

async function deletePreset(index: number): Promise<void> {
  if (store.polishPresets[index]?.builtIn) return
  store.polishPresets.splice(index, 1)
  // Adjust active index
  if (store.activePresetIndex >= store.polishPresets.length) {
    store.activePresetIndex = store.polishPresets.length - 1
  }
  if (store.activePresetIndex === index || store.activePresetIndex >= store.polishPresets.length) {
    store.activePresetIndex = 0
  }
  store.polishPrompt = store.polishPresets[store.activePresetIndex].prompt
  await store.saveSetting('polishPresets', store.polishPresets)
  await store.saveSetting('activePresetIndex', store.activePresetIndex)
  await store.saveSetting('polishPrompt', store.polishPrompt)
  showSaveMessage('已删除')
}

const editingPresetName = ref(false)
const editPresetNameValue = ref('')
const showCustomAsrModel = ref(false)
const showCustomPolishModel = ref(false)
const showCustomAssistantModel = ref(false)
const showCustomVocabModel = ref(false)

function isCustomModel(model: string, presets: readonly string[]): boolean {
  return !presets.includes(model)
}

function syncCustomModelState(): void {
  showCustomAsrModel.value = isCustomModel(store.asrModel, ASR_MODEL_PRESETS)
  showCustomPolishModel.value = isCustomModel(store.polishModel, TEXT_MODEL_PRESETS)
  showCustomAssistantModel.value = isCustomModel(store.assistantModel, TEXT_MODEL_PRESETS)
  showCustomVocabModel.value = isCustomModel(store.vocabularyModel, FLASH_ASR_MODEL_PRESETS as unknown as string[])
}

function startEditPresetName(index: number): void {
  editingPresetName.value = true
  editPresetNameValue.value = store.polishPresets[index].name
}

async function savePresetName(index: number): Promise<void> {
  if (editPresetNameValue.value.trim()) {
    store.polishPresets[index].name = editPresetNameValue.value.trim()
    await store.saveSetting('polishPresets', store.polishPresets)
  }
  editingPresetName.value = false
}

function isBuiltInModified(index: number): boolean {
  const preset = store.polishPresets[index]
  if (!preset?.builtIn) return false
  const original = BUILTIN_PRESETS.find(p => p.name === preset.name)
  return !!original && preset.prompt !== original.prompt
}

async function resetPreset(index: number): Promise<void> {
  const preset = store.polishPresets[index]
  if (!preset?.builtIn) return
  const original = BUILTIN_PRESETS.find(p => p.name === preset.name)
  if (!original) return
  preset.prompt = original.prompt
  if (store.activePresetIndex === index) {
    store.polishPrompt = original.prompt
    await store.saveSetting('polishPrompt', store.polishPrompt)
  }
  await store.saveSetting('polishPresets', store.polishPresets)
  showSaveMessage('已重置为默认提示词')
}

// Model save
async function addCustomModel(category: 'asr' | 'text' | 'vocab', model: string): Promise<void> {
  const trimmed = model.trim()
  if (!trimmed) return
  const list = store.customModels[category]
  if (!list.includes(trimmed)) {
    list.push(trimmed)
    await store.saveSetting('customModels', store.customModels)
  }
}

async function deleteCustomModel(category: 'asr' | 'text' | 'vocab', model: string): Promise<void> {
  const list = store.customModels[category]
  const idx = list.indexOf(model)
  if (idx !== -1) {
    list.splice(idx, 1)
    await store.saveSetting('customModels', store.customModels)
  }
}

async function saveAsrModel(): Promise<void> {
  await store.saveSetting('asrModel', store.asrModel)
  if (isCustomModel(store.asrModel, ASR_MODEL_PRESETS)) {
    await addCustomModel('asr', store.asrModel)
  }
  showSaveMessage('识别模型已保存')
}

async function savePolishModel(): Promise<void> {
  await store.saveSetting('polishModel', store.polishModel)
  if (isCustomModel(store.polishModel, TEXT_MODEL_PRESETS)) {
    await addCustomModel('text', store.polishModel)
  }
  showSaveMessage('润色模型已保存')
}

async function saveAssistantModel(): Promise<void> {
  await store.saveSetting('assistantModel', store.assistantModel)
  if (isCustomModel(store.assistantModel, TEXT_MODEL_PRESETS)) {
    await addCustomModel('text', store.assistantModel)
  }
  showSaveMessage('助手模型已保存')
}

async function selectAsrModel(model: string): Promise<void> {
  store.asrModel = model
  showCustomAsrModel.value = false
  await saveAsrModel()
}

async function selectPolishModel(model: string): Promise<void> {
  store.polishModel = model
  showCustomPolishModel.value = false
  await savePolishModel()
}

async function selectAssistantModel(model: string): Promise<void> {
  store.assistantModel = model
  showCustomAssistantModel.value = false
  await saveAssistantModel()
}

async function selectVocabModel(model: string): Promise<void> {
  store.vocabularyModel = model
  showCustomVocabModel.value = false
  await store.saveSetting('vocabularyModel', model)
}

async function saveVocabModel(): Promise<void> {
  await store.saveSetting('vocabularyModel', store.vocabularyModel)
  if (isCustomModel(store.vocabularyModel, FLASH_ASR_MODEL_PRESETS as unknown as string[])) {
    await addCustomModel('vocab', store.vocabularyModel)
  }
  showSaveMessage('增强识别模型已保存')
}

async function savePolishBaseUrl(): Promise<void> {
  store.polishBaseUrl = store.polishBaseUrl.replace(/\/+$/, '')
  await store.saveSetting('polishBaseUrl', store.polishBaseUrl)
  showSaveMessage('润色接入点已保存')
}

// Launch at login
async function toggleLaunchAtLogin(): Promise<void> {
  store.launchAtLogin = !store.launchAtLogin
  await store.saveSetting('launchAtLogin', store.launchAtLogin)
}

// Hide dock icon
async function toggleHideDockIcon(): Promise<void> {
  if (!showDockVisibilityToggle) return
  // Prevent toggle if update is in progress
  if (dockUpdateLocked.value) return
  store.hideDockIcon = !store.hideDockIcon
  await store.saveSetting('hideDockIcon', store.hideDockIcon)
}

// Audio threshold
async function onThresholdChange(event: Event): Promise<void> {
  const value = Number((event.target as HTMLInputElement).value)
  store.audioThreshold = value
  await store.saveSetting('audioThreshold', value)
}

// Microphone selection
interface AudioDevice { deviceId: string; label: string }
const microphoneDevices = ref<AudioDevice[]>([])

async function enumerateMicrophones(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    microphoneDevices.value = devices
      .filter(d => d.kind === 'audioinput' && d.deviceId !== '')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `麦克风 ${i + 1}`
      }))
  } catch (err) {
    console.error('Failed to enumerate devices:', err)
  }
}

async function selectMicrophone(event: Event): Promise<void> {
  const value = (event.target as HTMLSelectElement).value
  store.selectedMicrophoneId = value
  await store.saveSetting('selectedMicrophoneId', value)
  showSaveMessage('麦克风已切换')
}

// Permissions
const permissions = ref({ microphone: false, accessibility: false, screen: false })
const shortcutStatus = ref<ShortcutServiceStatus | null>(null)
let unsubscribeShortcutStatus: (() => void) | null = null

async function checkPermissions(): Promise<void> {
  try {
    permissions.value = await window.electronAPI.checkPermissions()
    shortcutStatus.value = await window.electronAPI.refreshShortcutStatus()
  } catch (err) {
    console.error('Failed to check permissions:', err)
  }
}

async function requestPermission(type: string): Promise<void> {
  await window.electronAPI.requestPermission(type)
  await checkPermissions()
}

function getShortcutModeStatus(mode: VoiceMode): ShortcutModeStatus | null {
  return shortcutStatus.value?.modes[mode] ?? null
}

function shortcutStatusText(mode: VoiceMode): string {
  const status = getShortcutModeStatus(mode)
  if (!status) return '正在检查快捷键状态...'

  if (status.backendState === 'native') return '已生效（原生监听）'
  if (status.backendState === 'fallback') return '已生效（兼容模式）'

  switch (status.reason) {
    case 'unsupported_without_accessibility':
    case 'permission_missing':
      return '需要辅助功能权限'
    case 'shortcut_conflict':
      return '快捷键被其他程序占用'
    case 'backend_failed':
      return '快捷键暂不可用'
    default:
      return '等待生效'
  }
}

function shortcutStatusClass(mode: VoiceMode): string {
  const status = getShortcutModeStatus(mode)
  if (!status) return 'pending'
  if (status.backendState === 'native' || status.backendState === 'fallback') return 'ready'
  if (status.reason === 'unsupported_without_accessibility' || status.reason === 'permission_missing') return 'warning'
  if (status.reason === 'shortcut_conflict') return 'warning'
  return 'error'
}

// Version
const version = ref('')

// Auto-update
const updateStatus = ref<UpdateStatusPayload | null>(null)
let unsubscribeUpdateStatus: (() => void) | null = null

function checkForUpdate(): void {
  window.electronAPI.checkForUpdate()
}

function downloadUpdate(): void {
  window.electronAPI.downloadUpdate()
}

function installUpdate(): void {
  window.electronAPI.installUpdate()
}

// History
const historyRecords = ref<TranscriptionRecord[]>([])

async function loadHistory(): Promise<void> {
  historyRecords.value = await window.electronAPI.getHistory()
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

async function updateHistoryMaxCount(event: Event): Promise<void> {
  const val = parseInt((event.target as HTMLInputElement).value, 10)
  const count = isNaN(val) || val < 10 ? 10 : val > 200 ? 200 : val
  store.historyMaxCount = count
  await store.saveSetting('historyMaxCount', count)
  showSaveMessage('历史记录保留数量已更新')
}

async function copyRecord(record: TranscriptionRecord): Promise<void> {
  const text = `原始文本：${record.originalText}\n润色后：${record.polishedText}`
  try {
    await navigator.clipboard.writeText(text)
    showSaveMessage('已复制到剪贴板')
  } catch (err) {
    console.error('Failed to copy:', err)
    showSaveMessage('复制失败')
  }
}

// Single onMounted: await loadSettings first, then use the data
onMounted(async () => {
  try {
    await store.loadSettings()
    syncCustomModelState()
    asrApiKeyInput.value = store.asrApiKey
    polishApiKeyInput.value = store.polishApiKey
    version.value = await window.electronAPI.getVersion()
    await checkPermissions()
    await enumerateMicrophones()
    await loadHistory()
    shortcutStatus.value = await window.electronAPI.getShortcutStatus()

    // Listen for dock update lock state
    unsubscribeDockLock = window.electronAPI.onDockUpdateLock((locked: boolean) => {
      dockUpdateLocked.value = locked
    })

    // Listen for history updates
    unsubscribeHistoryUpdate = window.electronAPI.onHistoryUpdated(() => {
      loadHistory()
    })

    unsubscribeShortcutStatus = window.electronAPI.onShortcutStatusChanged((status) => {
      shortcutStatus.value = status
    })

    // Listen for auto-update status
    updateStatus.value = await window.electronAPI.getUpdateStatus()
    unsubscribeUpdateStatus = window.electronAPI.onUpdateStatus((payload) => {
      updateStatus.value = payload as UpdateStatusPayload
    })

    // Load vocabulary and listen for updates
    await loadVocabulary()
    unsubscribeVocabularyUpdate = window.electronAPI.onVocabularyUpdated(() => {
      loadVocabulary()
    })
  } catch (err) {
    console.error('Failed to initialize settings:', err)
  }
})

onUnmounted(() => {
  if (unsubscribeDockLock) {
    unsubscribeDockLock()
  }
  if (unsubscribeHistoryUpdate) {
    unsubscribeHistoryUpdate()
  }
  if (unsubscribeVocabularyUpdate) {
    unsubscribeVocabularyUpdate()
  }
  if (unsubscribeShortcutStatus) {
    unsubscribeShortcutStatus()
  }
  if (unsubscribeUpdateStatus) {
    unsubscribeUpdateStatus()
  }
  stopShortcutListeners()
  if (shortcutCaptureSuspended) {
    shortcutCaptureSuspended = false
    void window.electronAPI.setShortcutCaptureActive(false)
  }
})

// ---- Vocabulary (Memory tab) functions ----

// Computed: category stats for filter chips
const personalCategoryStats = computed(() => {
  const counts = new Map<string, number>()
  for (const e of personalVocabulary.value) {
    counts.set(e.category, (counts.get(e.category) || 0) + 1)
  }
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count }))
})

const filteredPersonalVocabulary = computed(() => {
  if (vocabFilterCategory.value === '全部') return personalVocabulary.value
  return personalVocabulary.value.filter((e) => e.category === vocabFilterCategory.value)
})

const activeSharedSource = computed(() => {
  return store.sharedVocabSyncSources[sharedSourceTabIndex.value] ?? null
})

const activeSharedSourceEntries = computed(() => {
  const source = activeSharedSource.value
  if (!source) return []
  return sharedVocabulary.value.filter((e) => e.sourceUrl === source.url)
})

const sharedCategoryStats = computed(() => {
  const counts = new Map<string, number>()
  for (const e of activeSharedSourceEntries.value) {
    counts.set(e.category, (counts.get(e.category) || 0) + 1)
  }
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count }))
})

const filteredSharedVocabulary = computed(() => {
  if (vocabFilterCategory.value === '全部') return activeSharedSourceEntries.value
  return activeSharedSourceEntries.value.filter((e) => e.category === vocabFilterCategory.value)
})

function getSourceEntries(sourceUrl: string): VocabularyEntry[] {
  return sharedVocabulary.value.filter((e) => e.sourceUrl === sourceUrl)
}

async function loadVocabulary() {
  try {
    const [personal, shared, stats] = await Promise.all([
      window.electronAPI.getPersonalVocabulary(),
      window.electronAPI.getSharedVocabulary(),
      window.electronAPI.getVocabularyStats()
    ])
    personalVocabulary.value = personal
    sharedVocabulary.value = shared
    vocabStats.value = stats
  } catch (err) {
    console.error('Failed to load vocabulary:', err)
  }
}

async function addVocabularyEntry() {
  const term = vocabNewTerm.value.trim()
  if (!term) return
  if (personalVocabulary.value.length >= 200) {
    showSaveMessage('个人词汇已达上限 200 条，无法继续添加')
    return
  }
  try {
    const result = await window.electronAPI.addVocabulary('personal', {
      term,
      description: vocabNewDesc.value.trim(),
      category: vocabNewCategory.value
    })
    if (result.duplicate) {
      showSaveMessage(`词汇 "${term}" 已存在`)
      return
    }
    vocabNewTerm.value = ''
    vocabNewDesc.value = ''
    vocabNewCategory.value = '其他'
    showVocabAddForm.value = false
    await loadVocabulary()
  } catch (err) {
    console.error('Failed to add vocabulary:', err)
  }
}

function startEditVocabulary(entry: VocabularyEntry) {
  vocabEditingId.value = entry.id
  vocabEditTerm.value = entry.term
  vocabEditDesc.value = entry.description
  vocabEditCategory.value = entry.category
}

async function saveEditVocabulary(source: 'personal' | 'shared' = 'personal') {
  if (!vocabEditingId.value) return
  try {
    await window.electronAPI.updateVocabulary(source, vocabEditingId.value, {
      term: vocabEditTerm.value.trim(),
      description: vocabEditDesc.value.trim(),
      category: vocabEditCategory.value
    })
    vocabEditingId.value = null
    await loadVocabulary()
  } catch (err) {
    console.error('Failed to update vocabulary:', err)
  }
}

function cancelEditVocabulary() {
  vocabEditingId.value = null
}

async function deleteVocabularyEntry(source: 'personal' | 'shared', id: string) {
  try {
    await window.electronAPI.deleteVocabulary(source, id)
    await loadVocabulary()
  } catch (err) {
    console.error('Failed to delete vocabulary:', err)
  }
}

async function toggleVocabularyEntry(source: 'personal' | 'shared', entry: VocabularyEntry) {
  try {
    await window.electronAPI.updateVocabulary(source, entry.id, { enabled: !entry.enabled })
    await loadVocabulary()
  } catch (err) {
    console.error('Failed to toggle vocabulary:', err)
  }
}

async function importVocabulary() {
  try {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const text = await file.text()
      const parsed = JSON.parse(text)
      // Support both old array format and new {entries} format
      const entries = Array.isArray(parsed) ? parsed : (parsed.entries ?? [])
      if (Array.isArray(entries)) {
        const result = await window.electronAPI.importVocabulary('personal', entries)
        await loadVocabulary()
        let msg = `已导入 ${result.added} 条词汇`
        if (result.skipped > 0) msg += `，跳过 ${result.skipped} 条重复`
        if (result.limitReached) msg += '（已达上限 200 条）'
        showSaveMessage(msg)
      }
    }
    input.click()
  } catch (err) {
    console.error('Failed to import vocabulary:', err)
  }
}

async function addSyncSource(): Promise<void> {
  const url = syncSourceUrl.value.trim()
  if (!url) return
  vocabSyncLoading.value = true
  vocabSyncResult.value = ''
  try {
    const result = await window.electronAPI.syncVocabularyFromUrl(url)
    if (result.error) {
      vocabSyncResult.value = `同步失败: ${result.error}`
      vocabSyncLoading.value = false
      return
    }
    const name = syncSourceName.value.trim() || result.name || '未命名词典'
    const sources = [...store.sharedVocabSyncSources, { name, url, lastSyncAt: Date.now() }]
    store.sharedVocabSyncSources = sources
    await store.saveSetting('sharedVocabSyncSources', sources)
    syncSourceName.value = ''
    syncSourceUrl.value = ''
    showSyncSourceForm.value = false
    vocabSyncResult.value = `已同步 ${result.total} 条词汇`
    await loadVocabulary()
  } catch (err) {
    vocabSyncResult.value = `同步出错: ${(err as Error).message}`
  } finally {
    vocabSyncLoading.value = false
  }
}

async function syncSource(index: number): Promise<void> {
  const source = store.sharedVocabSyncSources[index]
  if (!source) return
  vocabSyncLoading.value = true
  vocabSyncResult.value = ''
  try {
    const result = await window.electronAPI.syncVocabularyFromUrl(source.url)
    if (result.error) {
      vocabSyncResult.value = `同步失败: ${result.error}`
    } else {
      const sources = [...store.sharedVocabSyncSources]
      sources[index] = { ...sources[index], lastSyncAt: Date.now() }
      store.sharedVocabSyncSources = sources
      await store.saveSetting('sharedVocabSyncSources', sources)
      vocabSyncResult.value = `已同步 ${result.total} 条词汇`
      await loadVocabulary()
    }
  } catch (err) {
    vocabSyncResult.value = `同步出错: ${(err as Error).message}`
  } finally {
    vocabSyncLoading.value = false
  }
}

async function removeSyncSource(index: number): Promise<void> {
  const source = store.sharedVocabSyncSources[index]
  if (!source) return
  await window.electronAPI.removeVocabularySource(source.url)
  const sources = store.sharedVocabSyncSources.filter((_, i) => i !== index)
  store.sharedVocabSyncSources = sources
  await store.saveSetting('sharedVocabSyncSources', sources)
  if (sharedSourceTabIndex.value >= sources.length) {
    sharedSourceTabIndex.value = Math.max(0, sources.length - 1)
  }
  vocabFilterCategory.value = '全部'
  await loadVocabulary()
}

async function exportVocabularyWithName(source: 'personal' | 'shared'): Promise<void> {
  try {
    const name = exportName.value.trim() || undefined
    const data = await window.electronAPI.exportVocabulary(source, name)
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `vocabulary-${source}${name ? '-' + name : ''}-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    exportName.value = ''
    showExportNameInput.value = false
  } catch (err) {
    console.error('Failed to export vocabulary:', err)
  }
}

async function toggleVocabularyEnabled() {
  const newVal = !store.vocabularyEnabled
  store.vocabularyEnabled = newVal
  await store.saveSetting('vocabularyEnabled', newVal)
}
</script>

<template>
  <div class="settings-layout">
    <!-- Save toast -->
    <Transition name="toast">
      <div v-if="saveMessage" class="save-toast">{{ saveMessage }}</div>
    </Transition>

    <!-- macOS title bar drag region -->
    <div class="titlebar-drag-region"></div>

    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">乐多汪汪</div>
      <nav class="sidebar-nav">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          :class="['nav-item', { active: activeTab === tab.id }]"
          @click="activeTab = tab.id"
        >
          <span class="nav-icon">{{ tab.icon }}</span>
          <span class="nav-label">{{ tab.label }}</span>
        </button>
      </nav>
    </aside>

    <!-- Content -->
    <main ref="contentRef" class="content">
      <!-- General Tab -->
      <div v-if="activeTab === 'general'" class="tab-content">
        <h2 class="section-title">通用设置</h2>

        <!-- Mode Toggles -->
        <div class="setting-group">
          <label class="setting-label">功能开关</label>
          <div class="mode-toggles-inline">
            <button
              class="mode-toggle-btn"
              :class="{ active: store.transcriptionEnabled }"
              @click="toggleTranscription"
            >
              <span class="mode-toggle-btn-icon">🎤</span>
              <span>语音识别</span>
            </button>
            <button
              class="mode-toggle-btn"
              :class="{ active: store.assistantEnabled }"
              @click="toggleAssistant"
            >
              <span class="mode-toggle-btn-icon">🤖</span>
              <span>语音助手</span>
            </button>
          </div>
        </div>

        <!-- Shortcuts -->
        <div class="setting-group">
          <label class="setting-label">全局快捷键</label>

          <!-- 语音识别快捷键 -->
          <div class="shortcut-row" :class="{ disabled: !store.transcriptionEnabled }" style="margin-bottom: 12px;">
            <div class="shortcut-info">
              <span class="shortcut-icon">🎤</span>
              <div class="shortcut-details">
                <span class="shortcut-name">语音识别</span>
                <span class="shortcut-desc">语音转文字输入</span>
                <span :class="['shortcut-status', shortcutStatusClass('transcription')]">
                  {{ shortcutStatusText('transcription') }}
                </span>
              </div>
            </div>
            <div class="shortcut-control">
              <span :class="['shortcut-display', { recording: recordingShortcut === 'transcription' }]">
                {{ recordingShortcut === 'transcription'
                  ? (shortcutDisplay.length ? shortcutDisplay.join('+') : '请按下快捷键...')
                  : store.transcriptionShortcut }}
              </span>
              <template v-if="recordingShortcut !== 'transcription'">
                <button class="btn btn-secondary" @click="startRecordShortcut('transcription')">修改</button>
                <button class="btn btn-text" @click="resetShortcut('transcription')">重置</button>
              </template>
              <template v-else-if="pendingShortcut">
                <button class="btn btn-primary" @click="confirmShortcut">保存</button>
                <button class="btn btn-secondary" @click="cancelShortcut">取消</button>
              </template>
              <template v-else>
                <button class="btn btn-secondary" @click="cancelShortcut">取消</button>
              </template>
            </div>
          </div>

          <!-- 语音助手快捷键 -->
          <div class="shortcut-row" :class="{ disabled: !store.assistantEnabled }">
            <div class="shortcut-info">
              <span class="shortcut-icon">🤖</span>
              <div class="shortcut-details">
                <span class="shortcut-name">语音助手</span>
                <span class="shortcut-desc">根据选中文本和屏幕截图回答问题</span>
                <span :class="['shortcut-status', shortcutStatusClass('assistant')]">
                  {{ shortcutStatusText('assistant') }}
                </span>
              </div>
            </div>
            <div class="shortcut-control">
              <span :class="['shortcut-display', { recording: recordingShortcut === 'assistant' }]">
                {{ recordingShortcut === 'assistant'
                  ? (shortcutDisplay.length ? shortcutDisplay.join('+') : '请按下快捷键...')
                  : store.assistantShortcut }}
              </span>
              <template v-if="recordingShortcut !== 'assistant'">
                <button class="btn btn-secondary" @click="startRecordShortcut('assistant')">修改</button>
                <button class="btn btn-text" @click="resetShortcut('assistant')">重置</button>
              </template>
              <template v-else-if="pendingShortcut">
                <button class="btn btn-primary" @click="confirmShortcut">保存</button>
                <button class="btn btn-secondary" @click="cancelShortcut">取消</button>
              </template>
              <template v-else>
                <button class="btn btn-secondary" @click="cancelShortcut">取消</button>
              </template>
            </div>
          </div>
        </div>

        <!-- Input method -->
        <div class="setting-group">
          <label class="setting-label">文字输入方式</label>
          <div class="radio-group">
            <label class="radio-item">
              <input
                type="radio"
                name="inputMethod"
                value="clipboard"
                :checked="store.inputMethod === 'clipboard'"
                @change="setInputMethod('clipboard')"
              />
              <span class="radio-text">
                <strong>剪贴板粘贴</strong>
                <small>通过 {{ pasteShortcutLabel }} 粘贴，兼容性最好</small>
              </span>
            </label>
            <label v-if="showAppleScriptInputMethod" class="radio-item">
              <input
                type="radio"
                name="inputMethod"
                value="applescript"
                :checked="store.inputMethod === 'applescript'"
                @change="setInputMethod('applescript')"
              />
              <span class="radio-text">
                <strong>模拟键盘输入</strong>
                <small>通过 AppleScript 模拟，不占用剪贴板</small>
              </span>
            </label>
          </div>
        </div>

        <!-- Microphone selection -->
        <div class="setting-group">
          <label class="setting-label">麦克风</label>
          <p class="setting-description">选择用于语音输入的麦克风设备。</p>
          <div class="setting-row">
            <select
              class="input-field"
              :value="store.selectedMicrophoneId"
              @change="selectMicrophone"
            >
              <option value="">系统默认</option>
              <option
                v-for="device in microphoneDevices"
                :key="device.deviceId"
                :value="device.deviceId"
              >
                {{ device.label }}
              </option>
            </select>
            <button class="btn btn-secondary" @click="enumerateMicrophones">刷新</button>
          </div>
        </div>

        <!-- Audio threshold -->
        <div class="setting-group">
          <label class="setting-label">录音音量门限</label>
          <p class="setting-description">低于此阈值的声音将被忽略，可过滤远处的背景人声。设为 0 表示不过滤。</p>
          <div class="slider-row">
            <input
              type="range"
              min="0"
              max="10"
              step="0.1"
              :value="store.audioThreshold"
              class="slider"
              @input="onThresholdChange"
            />
            <span class="slider-value">{{ store.audioThreshold }}</span>
          </div>
        </div>

        <!-- Polish toggle -->
        <div class="setting-group">
          <label class="setting-label">AI 润色</label>
          <div class="toggle-row">
            <span>启用 AI 文字润色</span>
            <button :class="['toggle', { active: store.polishEnabled }]" @click="togglePolish">
              <span class="toggle-thumb"></span>
            </button>
          </div>
          <div v-if="store.polishEnabled" class="toggle-row" style="margin-top: 8px">
            <span>发送屏幕截图 <small style="color: var(--text-secondary)">（需要多模态模型）</small></span>
            <button :class="['toggle', { active: store.screenshotEnabled }]" @click="toggleScreenshot">
              <span class="toggle-thumb"></span>
            </button>
          </div>
          <div v-if="store.polishEnabled && store.screenshotEnabled" class="setting-row" style="margin-top: 8px">
            <input
              class="input-field"
              :value="store.screenshotSavePath || '未设置（不保存到本地）'"
              readonly
              style="color: var(--text-secondary); cursor: default"
            />
            <button class="btn btn-secondary" @click="selectScreenshotFolder">选择文件夹</button>
            <button v-if="store.screenshotSavePath" class="btn btn-secondary" @click="openScreenshotFolder">打开</button>
            <button v-if="store.screenshotSavePath" class="btn btn-secondary" @click="clearScreenshotFolder">清除</button>
          </div>
          <div v-if="store.polishEnabled && store.screenshotEnabled && store.screenshotSavePath" class="setting-row" style="margin-top: 8px">
            <label class="setting-label" style="min-width: auto; font-size: 12px">保留数量</label>
            <input
              class="input-field"
              type="number"
              min="0"
              :value="store.screenshotMaxCount"
              style="max-width: 80px; text-align: center"
              @change="updateScreenshotMaxCount($event)"
            />
            <span style="font-size: 11px; color: var(--text-secondary)">张（0 为不限制）</span>
          </div>
          <div v-if="store.polishEnabled && store.screenshotEnabled" style="margin-top: 12px">
            <label class="setting-label" style="font-size: 12px">截图排除应用</label>
            <p style="font-size: 11px; color: var(--text-secondary); margin: 2px 0 8px">当前台应用在此列表中时，将跳过截图</p>
            <div v-if="store.screenshotExcludedApps.length > 0" class="excluded-app-list">
              <div v-for="app in store.screenshotExcludedApps" :key="app.bundleId" class="excluded-app-item">
                <span>{{ app.name }}</span>
                <button class="btn btn-secondary" style="padding: 2px 8px; font-size: 11px" @click="removeExcludedApp(app.bundleId)">移除</button>
              </div>
            </div>
            <div class="setting-row" style="margin-top: 6px">
              <select class="input-field" v-model="selectedAppBundleId" @focus="refreshRunningApps">
                <option value="" disabled>选择运行中的应用...</option>
                <option v-for="app in runningApps" :key="app.bundleId" :value="app.bundleId">{{ app.name }}</option>
              </select>
              <button class="btn btn-secondary" @click="refreshRunningApps">刷新</button>
              <button class="btn btn-secondary" :disabled="!selectedAppBundleId" @click="addExcludedApp">添加</button>
            </div>
          </div>
        </div>

        <!-- Launch at login -->
        <div class="setting-group">
          <label class="setting-label">启动</label>
          <div class="toggle-row">
            <span>开机自启动</span>
            <button :class="['toggle', { active: store.launchAtLogin }]" @click="toggleLaunchAtLogin">
              <span class="toggle-thumb"></span>
            </button>
          </div>
          <div v-if="showDockVisibilityToggle" class="toggle-row" style="margin-top: 8px">
            <span>
              隐藏 Dock 栏图标
              <small style="color: var(--text-secondary)">（显示图标需重启生效）</small>
            </span>
            <button
              :class="['toggle', { active: store.hideDockIcon, disabled: dockUpdateLocked }]"
              :disabled="dockUpdateLocked"
              @click="toggleHideDockIcon"
            >
              <span class="toggle-thumb"></span>
            </button>
          </div>
        </div>

        <!-- Permissions -->
        <div class="setting-group">
          <div class="permission-header">
            <label class="setting-label">系统权限</label>
            <button class="btn btn-secondary btn-sm" @click="checkPermissions">刷新</button>
          </div>
          <div class="permission-list">
            <div v-if="showAccessibilityPermission" class="permission-item">
              <span>
                <span :class="['status-dot', permissions.microphone ? 'green' : 'red']"></span>
                麦克风权限
              </span>
              <button v-if="!permissions.microphone" class="btn btn-secondary" @click="requestPermission('microphone')">
                授权
              </button>
              <span v-else class="permission-granted">已授权</span>
            </div>
            <div v-if="showScreenPermission" class="permission-item">
              <span>
                <span :class="['status-dot', permissions.accessibility ? 'green' : 'red']"></span>
                辅助功能权限
              </span>
              <button v-if="!permissions.accessibility" class="btn btn-secondary" @click="requestPermission('accessibility')">
                授权
              </button>
              <span v-else class="permission-granted">已授权</span>
            </div>
            <div class="permission-item">
              <span>
                <span :class="['status-dot', permissions.screen ? 'green' : 'red']"></span>
                屏幕录制权限
              </span>
              <button v-if="!permissions.screen" class="btn btn-secondary" @click="requestPermission('screen')">
                授权
              </button>
              <span v-else class="permission-granted">已授权</span>
            </div>
          </div>
        </div>
      </div>

      <!-- API Tab -->
      <div v-if="activeTab === 'api'" class="tab-content">
        <h2 class="section-title">API 配置</h2>

        <!-- ASR Section -->
        <div class="api-section">
          <h3 class="api-section-title">语音识别</h3>

          <div class="setting-group">
            <label class="setting-label">API Key</label>
            <p class="setting-hint">默认使用阿里云百炼平台，推荐在百炼控制台获取 API Key。失去焦点后会自动保存。</p>
            <div class="api-key-row">
              <input
                v-model="asrApiKeyInput"
                :type="asrApiKeyVisible ? 'text' : 'password'"
                class="input-field"
                placeholder="sk-..."
                @blur="saveAsrApiKey"
                @keydown.enter.prevent="saveAsrApiKey"
              />
              <button class="btn btn-secondary" @click="asrApiKeyVisible = !asrApiKeyVisible">
                {{ asrApiKeyVisible ? '隐藏' : '显示' }}
              </button>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">接入点</label>
            <p class="setting-hint">WebSocket 地址，model 参数会自动附加。使用百炼时无需修改。</p>
            <div class="setting-row">
              <input
                v-model="store.asrBaseUrl"
                class="input-field"
                :placeholder="ASR_DEFAULT_BASE_URL"
              />
              <button
                v-if="store.asrBaseUrl !== ASR_DEFAULT_BASE_URL"
                class="btn btn-secondary"
                @click="resetAsrBaseUrl"
              >重置为百炼</button>
              <button class="btn btn-primary" @click="saveAsrBaseUrl">保存</button>
            </div>
          </div>

        </div>

        <!-- Polish Section -->
        <div class="api-section">
          <h3 class="api-section-title">AI 润色</h3>

          <div class="setting-group">
            <label class="setting-label">API Key</label>
            <p class="setting-hint">默认使用阿里云百炼平台，也可替换为任何 OpenAI 兼容的接口。失去焦点后会自动保存。</p>
            <div class="api-key-row">
              <input
                v-model="polishApiKeyInput"
                :type="polishApiKeyVisible ? 'text' : 'password'"
                class="input-field"
                placeholder="sk-..."
                @blur="savePolishApiKey"
                @keydown.enter.prevent="savePolishApiKey"
              />
              <button class="btn btn-secondary" @click="polishApiKeyVisible = !polishApiKeyVisible">
                {{ polishApiKeyVisible ? '隐藏' : '显示' }}
              </button>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">接入点</label>
            <p class="setting-hint">OpenAI 兼容的 endpoint。使用百炼时无需修改。</p>
            <div class="setting-row">
              <input
                v-model="store.polishBaseUrl"
                class="input-field"
                :placeholder="POLISH_DEFAULT_BASE_URL"
              />
              <button
                v-if="store.polishBaseUrl !== POLISH_DEFAULT_BASE_URL"
                class="btn btn-secondary"
                @click="resetPolishBaseUrl"
              >重置为百炼</button>
              <button class="btn btn-primary" @click="savePolishBaseUrl">保存</button>
            </div>
          </div>

        </div>
      </div>

      <!-- Transcription Prompt Tab -->
      <div v-if="activeTab === 'prompt-transcription'" class="tab-content">
        <h2 class="section-title">语音识别</h2>
          <div class="setting-group">
            <label class="setting-label">识别模型</label>
            <p class="setting-description">直接选择常用 ASR 模型；如果需要，也可以展开自定义模型名。</p>
            <div class="model-chip-list">
              <button
                v-for="model in ASR_MODEL_PRESETS"
                :key="model"
                :class="['preset-chip', { active: store.asrModel === model && !showCustomAsrModel }]"
                @click="selectAsrModel(model)"
              >
                {{ model }}
              </button>
              <span
                v-for="model in store.customModels.asr"
                :key="'custom-' + model"
                :class="['preset-chip', 'preset-custom', { active: store.asrModel === model && !showCustomAsrModel }]"
                @click="selectAsrModel(model)"
              >
                {{ model }}
                <span class="chip-delete" @click.stop="deleteCustomModel('asr', model)">×</span>
              </span>
              <button
                :class="['preset-chip', 'preset-add', { active: showCustomAsrModel }]"
                @click="showCustomAsrModel = !showCustomAsrModel"
              >
                + 自定义
              </button>
            </div>
            <div v-if="showCustomAsrModel" class="setting-row model-custom-row">
              <input
                v-model="store.asrModel"
                class="input-field"
                placeholder="输入自定义 ASR 模型名"
              />
              <button class="btn btn-primary" @click="saveAsrModel(); showCustomAsrModel = false">保存</button>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">润色模型</label>
            <p class="setting-description">当启用 AI 润色时，使用这个模型处理最终文本。</p>
            <div class="model-chip-list">
              <button
                v-for="model in TEXT_MODEL_PRESETS"
                :key="model"
                :class="['preset-chip', { active: store.polishModel === model && !showCustomPolishModel }]"
                @click="selectPolishModel(model)"
              >
                {{ model }}
              </button>
              <span
                v-for="model in store.customModels.text"
                :key="'custom-' + model"
                :class="['preset-chip', 'preset-custom', { active: store.polishModel === model && !showCustomPolishModel }]"
                @click="selectPolishModel(model)"
              >
                {{ model }}
                <span class="chip-delete" @click.stop="deleteCustomModel('text', model)">×</span>
              </span>
              <button
                :class="['preset-chip', 'preset-add', { active: showCustomPolishModel }]"
                @click="showCustomPolishModel = !showCustomPolishModel"
              >
                + 自定义
              </button>
            </div>
            <div v-if="showCustomPolishModel" class="setting-row model-custom-row">
              <input
                v-model="store.polishModel"
                class="input-field"
                placeholder="输入自定义润色模型名"
              />
              <button class="btn btn-primary" @click="savePolishModel(); showCustomPolishModel = false">保存</button>
            </div>
          </div>

          <!-- Preset selector -->
          <div class="setting-group">
            <label class="setting-label">提示词预设</label>
            <div class="preset-list">
              <button
                v-for="(preset, index) in store.polishPresets"
                :key="index"
                :class="['preset-chip', { active: store.activePresetIndex === index }]"
                @click="switchPreset(index)"
              >
                {{ preset.name }}
                <span v-if="preset.builtIn" class="preset-badge">内置</span>
              </button>
              <button class="preset-chip preset-add" @click="addPreset">+ 新建</button>
            </div>
          </div>

          <!-- Active preset header -->
          <div class="setting-group">
            <div class="preset-header">
              <template v-if="editingPresetName">
                <input
                  v-model="editPresetNameValue"
                  class="input-field preset-name-input"
                  @keyup.enter="savePresetName(store.activePresetIndex)"
                />
                <button class="btn btn-primary btn-sm" @click="savePresetName(store.activePresetIndex)">确定</button>
              </template>
              <template v-else>
                <label class="setting-label" style="margin-bottom:0">
                  {{ store.polishPresets[store.activePresetIndex]?.name }}
                </label>
                <button
                  v-if="!store.polishPresets[store.activePresetIndex]?.builtIn"
                  class="btn btn-secondary btn-sm"
                  @click="startEditPresetName(store.activePresetIndex)"
                >重命名</button>
                <button
                  v-if="!store.polishPresets[store.activePresetIndex]?.builtIn"
                  class="btn btn-secondary btn-sm btn-danger"
                  @click="deletePreset(store.activePresetIndex)"
                >删除</button>
                <button
                  v-if="isBuiltInModified(store.activePresetIndex)"
                  class="btn btn-secondary btn-sm"
                  @click="resetPreset(store.activePresetIndex)"
                >重置</button>
              </template>
            </div>
          </div>

          <!-- Prompt editor -->
          <div class="setting-group">
            <p class="setting-description">
              自定义 AI 润色的系统提示词。语音识别的原始文本会作为用户消息发送给模型。
            </p>
            <textarea
              v-model="store.polishPrompt"
              class="input-field"
              rows="12"
              placeholder="你是一个文字润色助手..."
            ></textarea>
            <div class="prompt-actions">
              <button class="btn btn-primary" @click="savePolishPrompt">保存提示词</button>
            </div>
          </div>
      </div>

      <!-- Assistant Prompt Tab -->
      <div v-if="activeTab === 'prompt-assistant'" class="tab-content">
        <h2 class="section-title">语音助手</h2>
          <div class="setting-group">
            <label class="setting-label">助手模型</label>
            <p class="setting-description">选择语音助手回答时使用的模型，也可以展开自定义模型名。</p>
            <div class="model-chip-list">
              <button
                v-for="model in TEXT_MODEL_PRESETS"
                :key="model"
                :class="['preset-chip', { active: store.assistantModel === model && !showCustomAssistantModel }]"
                @click="selectAssistantModel(model)"
              >
                {{ model }}
              </button>
              <span
                v-for="model in store.customModels.text"
                :key="'custom-' + model"
                :class="['preset-chip', 'preset-custom', { active: store.assistantModel === model && !showCustomAssistantModel }]"
                @click="selectAssistantModel(model)"
              >
                {{ model }}
                <span class="chip-delete" @click.stop="deleteCustomModel('text', model)">×</span>
              </span>
              <button
                :class="['preset-chip', 'preset-add', { active: showCustomAssistantModel }]"
                @click="showCustomAssistantModel = !showCustomAssistantModel"
              >
                + 自定义
              </button>
            </div>
            <div v-if="showCustomAssistantModel" class="setting-row model-custom-row">
              <input
                v-model="store.assistantModel"
                class="input-field"
                placeholder="输入自定义助手模型名"
              />
              <button class="btn btn-primary" @click="saveAssistantModel(); showCustomAssistantModel = false">保存</button>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">能力选项</label>
            <div class="toggle-stack">
              <div class="toggle-row">
                <div>
                  <div class="setting-label toggle-title">深度思考</div>
                  <div class="setting-description toggle-description">
                    {{ store.assistantEnableCodeInterpreter
                      ? '只对语音助手生效。代码解释器模式依赖思考能力，所以这里会自动保持开启。'
                      : '只对语音助手生效。打开后通常回答更完整，但等待时间也会更长。'
                    }}
                  </div>
                </div>
                <button
                  :class="['toggle', { active: store.assistantEnableThinking, disabled: store.assistantEnableCodeInterpreter }]"
                  :disabled="store.assistantEnableCodeInterpreter"
                  @click="toggleAssistantThinking"
                >
                  <span class="toggle-thumb"></span>
                </button>
              </div>

              <div v-if="store.assistantEnableThinking" class="setting-row inline-input-row">
                <div class="inline-field-label">
                  <div class="setting-label toggle-title">思考 Token 数</div>
                  <div class="setting-description toggle-description">只对支持 `thinking_budget` 的助手模型生效，用来控制思考阶段最多消耗多少 Token。默认值是 256。</div>
                </div>
                <input
                  :value="store.assistantThinkingBudget"
                  type="number"
                  min="1"
                  step="64"
                  class="input-field compact-number-input"
                  @change="saveAssistantThinkingBudget"
                />
              </div>

              <div class="toggle-row">
                <div>
                  <div class="setting-label toggle-title">联网搜索</div>
                  <div class="setting-description toggle-description">只对语音助手生效。打开后表示允许模型在需要时联网搜索，不会每次都强制触发。</div>
                </div>
                <button
                  :class="['toggle', { active: store.assistantEnableSearch }]"
                  @click="toggleAssistantSearch"
                >
                  <span class="toggle-thumb"></span>
                </button>
              </div>

              <div class="toggle-row">
                <div>
                  <div class="setting-label toggle-title">Python 解释器</div>
                  <div class="setting-description toggle-description">只对语音助手生效。打开后会改用工具调用模式，支持执行 Python 代码，并在结果弹窗中展示工具次数和 Token 消耗。</div>
                </div>
                <button
                  :class="['toggle', { active: store.assistantEnableCodeInterpreter }]"
                  @click="toggleAssistantCodeInterpreter"
                >
                  <span class="toggle-thumb"></span>
                </button>
              </div>
            </div>
          </div>

          <!-- 先进行AI润色选项 -->
          <div class="setting-group">
            <label class="setting-label">处理流程</label>
            <div class="radio-group">
              <label class="radio-item" @click="toggleAssistantPrePolish(false)">
                <input
                  type="radio"
                  name="assistantPrePolish"
                  :checked="!store.assistantPrePolish"
                />
                <span class="radio-text">
                  <strong>直接处理</strong>
                  <small>语音文本直接发送给语音助手</small>
                </span>
              </label>
              <label class="radio-item" @click="toggleAssistantPrePolish(true)">
                <input
                  type="radio"
                  name="assistantPrePolish"
                  :checked="store.assistantPrePolish"
                />
                <span class="radio-text">
                  <strong>先润色再处理</strong>
                  <small>先用AI润色语音文本，再将润色后的文本发送给语音助手</small>
                </span>
              </label>
            </div>
          </div>

          <div class="setting-group">
            <label class="setting-label">输出方式</label>
            <div class="radio-group">
              <label class="radio-item" @click="setAssistantOutputMode('input')">
                <input
                  type="radio"
                  name="assistantOutputMode"
                  :checked="store.assistantOutputMode === 'input'"
                />
                <span class="radio-text">
                  <strong>自动输入到当前应用</strong>
                  <small>沿用当前输入方式，直接回填到前台应用</small>
                </span>
              </label>
              <label class="radio-item" @click="setAssistantOutputMode('window')">
                <input
                  type="radio"
                  name="assistantOutputMode"
                  :checked="store.assistantOutputMode === 'window'"
                />
                <span class="radio-text">
                  <strong>显示在独立弹窗</strong>
                  <small>在当前屏幕弹出结果窗口，方便阅读和复制</small>
                </span>
              </label>
            </div>
          </div>

          <!-- Preset selector -->
          <div class="setting-group">
            <label class="setting-label">助手预设</label>
            <div class="preset-list">
              <button
                v-for="(preset, index) in store.assistantPresets"
                :key="index"
                :class="['preset-chip', { active: store.assistantActivePresetIndex === index }]"
                @click="switchAssistantPreset(index)"
              >
                {{ preset.name }}
                <span v-if="preset.builtIn" class="preset-badge">内置</span>
              </button>
              <button class="preset-chip preset-add" @click="addAssistantPreset">+ 新建</button>
            </div>
          </div>

          <!-- Prompt editor -->
          <div class="setting-group">
            <p class="setting-description">
              自定义语音助手的系统提示词。用户语音会作为问题发送给模型。
            </p>
            <textarea
              v-model="store.assistantPrompt"
              class="input-field"
              rows="12"
              placeholder="你是一个智能助手..."
            ></textarea>
            <div class="prompt-actions">
              <button class="btn btn-primary" @click="saveAssistantPrompt">保存提示词</button>
              <button class="btn btn-text" @click="resetAssistantPrompt">重置为默认</button>
            </div>
          </div>
      </div>


      <!-- Memory Tab -->
      <div v-if="activeTab === 'memory'" class="tab-content">
        <h2 class="section-title">词汇记忆</h2>
        <p class="setting-description">添加专有名词帮助语音识别更准确地识别特定词汇。</p>

        <!-- 3 sub-tabs -->
        <div class="mode-tabs" style="margin-top: 8px;">
          <button :class="['mode-tab', { active: vocabSubTab === 'settings' }]" @click="vocabSubTab = 'settings'">
            通用设置
          </button>
          <button :class="['mode-tab', { active: vocabSubTab === 'personal' }]" @click="vocabSubTab = 'personal'">
            个人词汇 ({{ vocabStats.personalCount }})
          </button>
          <button :class="['mode-tab', { active: vocabSubTab === 'shared' }]" @click="vocabSubTab = 'shared'">
            共享词汇 ({{ vocabStats.sharedCount }})
          </button>
        </div>

        <!-- Settings sub-tab -->
        <div v-if="vocabSubTab === 'settings'">
          <div class="setting-group">
            <div class="toggle-row">
              <span>启用词汇增强识别</span>
              <button :class="['toggle', { active: store.vocabularyEnabled }]" @click="toggleVocabularyEnabled">
                <span class="toggle-thumb"></span>
              </button>
            </div>
          </div>

          <template v-if="store.vocabularyEnabled">
            <div class="setting-group">
              <label class="setting-label">增强识别模型</label>
              <div class="model-chip-list">
                <button
                  v-for="model in FLASH_ASR_MODEL_PRESETS"
                  :key="model"
                  :class="['preset-chip', { active: store.vocabularyModel === model && !showCustomVocabModel }]"
                  @click="selectVocabModel(model)"
                >
                  {{ model }}
                </button>
                <span
                  v-for="model in store.customModels.vocab"
                  :key="'custom-' + model"
                  :class="['preset-chip', 'preset-custom', { active: store.vocabularyModel === model && !showCustomVocabModel }]"
                  @click="selectVocabModel(model)"
                >
                  {{ model }}
                  <span class="chip-delete" @click.stop="deleteCustomModel('vocab', model)">×</span>
                </span>
                <button
                  :class="['preset-chip', 'preset-add', { active: showCustomVocabModel }]"
                  @click="showCustomVocabModel = !showCustomVocabModel"
                >
                  + 自定义
                </button>
              </div>
              <div v-if="showCustomVocabModel" class="setting-row model-custom-row">
                <input
                  v-model="store.vocabularyModel"
                  class="input-field"
                  placeholder="输入自定义模型名"
                />
                <button class="btn btn-primary" @click="saveVocabModel(); showCustomVocabModel = false">保存</button>
              </div>
            </div>
          </template>
        </div>

        <!-- Personal vocabulary sub-tab -->
        <div v-if="vocabSubTab === 'personal'">
          <div class="vocab-toolbar">
            <span class="vocab-toolbar-info">已启用 {{ vocabStats.activeCount }} 条</span>
            <div class="vocab-toolbar-actions">
              <button class="vocab-icon-btn" title="添加" @click="showVocabAddForm = !showVocabAddForm">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              </button>
              <button class="vocab-icon-btn" title="导入" @click="importVocabulary">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </button>
              <button class="vocab-icon-btn" title="导出" @click="showExportNameInput = !showExportNameInput">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
              </button>
            </div>
          </div>

          <!-- Export name input -->
          <div v-if="showExportNameInput" class="vocab-add-form">
            <input class="input-field" v-model="exportName" placeholder="词典名称（可选）" style="flex: 1">
            <button class="btn btn-primary btn-sm" @click="exportVocabularyWithName('personal')">导出</button>
            <button class="btn btn-text btn-sm" @click="showExportNameInput = false">取消</button>
          </div>

          <!-- Add form (collapsible) -->
          <div v-if="showVocabAddForm" class="vocab-add-form">
            <input class="input-field vocab-input-term" v-model="vocabNewTerm" placeholder="词汇 *" @keydown.enter="addVocabularyEntry">
            <input class="input-field vocab-input-desc" v-model="vocabNewDesc" placeholder="描述（可选）">
            <select class="input-field vocab-input-category" v-model="vocabNewCategory">
              <option v-for="cat in VOCABULARY_CATEGORY_PRESETS" :key="cat" :value="cat">{{ cat }}</option>
            </select>
            <button class="btn btn-primary btn-sm" @click="addVocabularyEntry" :disabled="!vocabNewTerm.trim()">确认</button>
            <button class="btn btn-text btn-sm" @click="showVocabAddForm = false">取消</button>
          </div>

          <!-- Category filter chips -->
          <div class="vocab-filter-chips">
            <button
              :class="['filter-chip', { active: vocabFilterCategory === '全部' }]"
              @click="vocabFilterCategory = '全部'"
            >全部 ({{ personalVocabulary.length }})</button>
            <template v-for="cat in personalCategoryStats" :key="cat.name">
              <button
                :class="['filter-chip', { active: vocabFilterCategory === cat.name }]"
                @click="vocabFilterCategory = cat.name"
              >{{ cat.name }} ({{ cat.count }})</button>
            </template>
          </div>

          <!-- Personal list -->
          <div class="vocab-list-container">
            <div class="vocab-list" v-if="filteredPersonalVocabulary.length > 0">
              <div v-for="entry in filteredPersonalVocabulary" :key="entry.id" :class="['vocab-item', { disabled: !entry.enabled }]">
                <template v-if="vocabEditingId === entry.id">
                  <div class="vocab-edit-row">
                    <input class="input-field vocab-input-term" v-model="vocabEditTerm" @keydown.enter="saveEditVocabulary('personal')">
                    <input class="input-field vocab-input-desc" v-model="vocabEditDesc">
                    <select class="input-field vocab-input-category" v-model="vocabEditCategory">
                      <option v-for="cat in VOCABULARY_CATEGORY_PRESETS" :key="cat" :value="cat">{{ cat }}</option>
                    </select>
                    <div class="vocab-edit-actions">
                      <button class="btn btn-primary btn-sm" @click="saveEditVocabulary('personal')">保存</button>
                      <button class="btn btn-text btn-sm" @click="cancelEditVocabulary">取消</button>
                    </div>
                  </div>
                </template>
                <template v-else>
                  <div class="vocab-item-main">
                    <span class="vocab-term">{{ entry.term }}</span>
                    <span class="vocab-category">{{ entry.category }}</span>
                    <span v-if="entry.description" class="vocab-desc" :title="entry.description">{{ entry.description }}</span>
                  </div>
                  <div class="vocab-item-actions">
                    <button :class="['toggle toggle-xs', { active: entry.enabled }]" @click="toggleVocabularyEntry('personal', entry)">
                      <span class="toggle-thumb"></span>
                    </button>
                    <button class="vocab-icon-btn" title="编辑" @click="startEditVocabulary(entry)">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
                    </button>
                    <button class="vocab-icon-btn vocab-icon-btn-danger" title="删除" @click="deleteVocabularyEntry('personal', entry.id)">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                    </button>
                  </div>
                </template>
              </div>
            </div>
            <div v-else class="vocab-empty">
              {{ vocabFilterCategory === '全部' ? '暂无个人词汇' : '该分类下暂无词汇' }}
            </div>
          </div>
        </div>

        <!-- Shared vocabulary sub-tab -->
        <div v-if="vocabSubTab === 'shared'">
          <!-- Add sync source form -->
          <div class="setting-group">
            <div v-if="showSyncSourceForm" class="vocab-add-form">
              <input class="input-field" v-model="syncSourceUrl" placeholder="同步地址 *" style="flex: 2">
              <input class="input-field" v-model="syncSourceName" placeholder="名称（可选，自动识别）" style="flex: 1">
              <button class="btn btn-primary btn-sm" @click="addSyncSource" :disabled="!syncSourceUrl.trim() || vocabSyncLoading">
                {{ vocabSyncLoading ? '同步中...' : '确认' }}
              </button>
              <button class="btn btn-text btn-sm" @click="showSyncSourceForm = false">取消</button>
            </div>
            <div style="display: flex; align-items: center; gap: 8px;">
              <button v-if="!showSyncSourceForm" class="btn btn-text btn-sm" @click="showSyncSourceForm = true">
                + 添加同步源
              </button>
              <span v-if="vocabSyncResult" class="vocab-sync-result">{{ vocabSyncResult }}</span>
            </div>
          </div>

          <!-- Sync source tabs -->
          <template v-if="store.sharedVocabSyncSources.length > 0">
            <div class="shared-source-tabs">
              <button
                v-for="(source, idx) in store.sharedVocabSyncSources"
                :key="idx"
                :class="['shared-source-tab', { active: sharedSourceTabIndex === idx }]"
                @click="sharedSourceTabIndex = idx; vocabFilterCategory = '全部'"
              >
                <span class="shared-source-tab-name">{{ source.name }}</span>
                <span class="shared-source-tab-count">{{ getSourceEntries(source.url).length }}</span>
              </button>
            </div>

            <!-- Active source content -->
            <div v-if="activeSharedSource" class="shared-source-content">
              <!-- Source info + actions bar -->
              <div class="shared-source-bar">
                <div class="sync-source-info">
                  <span class="sync-source-url" :title="activeSharedSource.url">{{ activeSharedSource.url }}</span>
                  <span v-if="activeSharedSource.lastSyncAt" class="sync-source-time">{{ new Date(activeSharedSource.lastSyncAt).toLocaleDateString() }} 同步</span>
                </div>
                <div class="sync-source-actions">
                  <button class="vocab-icon-btn" title="同步" :disabled="vocabSyncLoading" @click="syncSource(sharedSourceTabIndex)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                  </button>
                  <button class="vocab-icon-btn vocab-icon-btn-danger" title="移除" @click="removeSyncSource(sharedSourceTabIndex)">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                  </button>
                </div>
              </div>

              <!-- Category filter chips -->
              <div class="vocab-filter-chips">
                <button
                  :class="['filter-chip', { active: vocabFilterCategory === '全部' }]"
                  @click="vocabFilterCategory = '全部'"
                >全部 ({{ activeSharedSourceEntries.length }})</button>
                <template v-for="cat in sharedCategoryStats" :key="cat.name">
                  <button
                    :class="['filter-chip', { active: vocabFilterCategory === cat.name }]"
                    @click="vocabFilterCategory = cat.name"
                  >{{ cat.name }} ({{ cat.count }})</button>
                </template>
              </div>

              <!-- Vocabulary list -->
              <div class="vocab-list-container">
                <div class="vocab-list" v-if="filteredSharedVocabulary.length > 0">
                  <div v-for="entry in filteredSharedVocabulary" :key="entry.id" :class="['vocab-item', { disabled: !entry.enabled }]">
                    <div class="vocab-item-main">
                      <span class="vocab-term">{{ entry.term }}</span>
                      <span class="vocab-category">{{ entry.category }}</span>
                      <span v-if="entry.description" class="vocab-desc" :title="entry.description">{{ entry.description }}</span>
                    </div>
                    <div class="vocab-item-actions">
                      <button :class="['toggle toggle-xs', { active: entry.enabled }]" @click="toggleVocabularyEntry('shared', entry)">
                        <span class="toggle-thumb"></span>
                      </button>
                    </div>
                  </div>
                </div>
                <div v-else class="vocab-empty">
                  {{ vocabFilterCategory === '全部' ? '尚未同步，点击同步按钮获取词汇' : '该分类下暂无词汇' }}
                </div>
              </div>
            </div>
          </template>
          <div v-else class="vocab-empty" style="margin-top: 12px;">暂无同步源，点击上方添加</div>
        </div>
      </div>

            <!-- History Tab -->
      <div v-if="activeTab === 'history'" class="tab-content">
        <h2 class="section-title">识别历史</h2>
        <div class="setting-group">
          <label class="setting-label">保留数量</label>
          <p class="setting-description">最多保留多少条历史记录，超出后自动删除旧记录。</p>
          <div class="setting-row">
            <input
              class="input-field"
              type="number"
              min="10"
              max="200"
              :value="store.historyMaxCount"
              style="max-width: 100px; text-align: center"
              @change="updateHistoryMaxCount($event)"
            />
            <span style="font-size: 13px; color: var(--text-secondary)">条</span>
          </div>
        </div>
        <div v-if="historyRecords.length === 0" class="empty-history">
          暂无识别记录
        </div>
        <div v-else class="history-list">
          <div v-for="record in historyRecords" :key="record.id" class="history-item">
            <div class="history-header">
              <span class="history-time">{{ formatTime(record.timestamp) }}</span>
              <button class="btn btn-text btn-sm" @click="copyRecord(record)">复制</button>
            </div>
            <div class="history-content">
              <div class="history-original">
                <label>原始文本</label>
                <p class="selectable-text">{{ record.originalText }}</p>
              </div>
              <div class="history-polished">
                <label>润色后</label>
                <p class="selectable-text">{{ record.polishedText }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- About Tab -->
      <div v-if="activeTab === 'about'" class="tab-content">
        <h2 class="section-title">关于</h2>
        <div class="about-content">
          <div class="about-app-name">乐多汪汪</div>
          <div class="about-english-name">Leduo Wow</div>
          <div class="about-version">版本 {{ version || '0.1.0' }}</div>

          <!-- Update Section -->
          <div class="update-section">
            <template v-if="!updateStatus || updateStatus.status === 'idle'">
              <button class="btn btn-secondary btn-sm" @click="checkForUpdate">检查更新</button>
            </template>
            <template v-else-if="updateStatus.status === 'checking'">
              <span class="update-status-text">正在检查更新...</span>
            </template>
            <template v-else-if="updateStatus.status === 'not-available'">
              <span class="update-status-text update-status-ok">当前已是最新版本</span>
            </template>
            <template v-else-if="updateStatus.status === 'available'">
              <span class="update-status-text">发现新版本 {{ updateStatus.newVersion }}</span>
              <button class="btn btn-primary btn-sm" @click="downloadUpdate" style="margin-left: 8px;">下载更新</button>
            </template>
            <template v-else-if="updateStatus.status === 'downloading'">
              <div class="update-progress-wrap">
                <span class="update-status-text">下载中 {{ updateStatus.progress ?? 0 }}%</span>
                <div class="update-progress-bar">
                  <div class="update-progress-fill" :style="{ width: (updateStatus.progress ?? 0) + '%' }"></div>
                </div>
              </div>
            </template>
            <template v-else-if="updateStatus.status === 'downloaded'">
              <span class="update-status-text">更新已就绪</span>
              <button class="btn btn-primary btn-sm" @click="installUpdate" style="margin-left: 8px;">安装并重启</button>
            </template>
            <template v-else-if="updateStatus.status === 'error'">
              <span class="update-status-text update-status-error">{{ updateStatus.error || '检查更新失败' }}</span>
              <button class="btn btn-secondary btn-sm" @click="checkForUpdate" style="margin-left: 8px;">重试</button>
            </template>
          </div>

          <p class="about-description">
            多平台语音输入与语音助手工具，按下快捷键即可语音输入，AI 自动润色或回答后输出到任意应用中。
          </p>
          <p class="about-author">作者：梦北</p>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.settings-layout {
  display: flex;
  height: 100vh;
  background: var(--bg-primary);
}

.titlebar-drag-region {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 38px;
  -webkit-app-region: drag;
  z-index: 100;
}

.sidebar {
  width: 180px;
  background: var(--bg-sidebar);
  border-right: 1px solid var(--border-color);
  padding-top: 48px;
  flex-shrink: 0;
}

.sidebar-header {
  padding: 0 16px 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}

.sidebar-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 0 8px;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: var(--radius);
  text-align: left;
  transition: background 0.15s;
}

.nav-item:hover {
  background: rgba(0, 0, 0, 0.05);
}

.nav-item.active {
  background: rgba(0, 113, 227, 0.1);
  color: var(--accent-color);
}

.nav-icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
}

.nav-label {
  font-size: 13px;
  font-weight: 500;
}

.content {
  flex: 1;
  overflow-y: auto;
  padding: 48px 32px 32px;
}

.tab-content {
  max-width: 560px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  margin-bottom: 24px;
}

.api-section {
  padding: 16px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  margin-bottom: 20px;
}

.api-section .setting-group:last-child {
  margin-bottom: 0;
}

.api-section-title {
  font-size: 14px;
  font-weight: 600;
  margin: 0 0 16px;
  color: var(--text-primary);
}

.setting-hint {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 2px 0 6px;
}

.setting-group {
  margin-bottom: 24px;
}

.setting-label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--text-primary);
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
}

.setting-row .input-field {
  flex: 1;
}

.shortcut-display {
  padding: 6px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  font-family: 'SF Mono', Menlo, monospace;
  font-size: 13px;
  min-width: 120px;
}

.shortcut-display.recording {
  border-color: var(--accent-color);
  background: rgba(0, 113, 227, 0.05);
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.radio-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color 0.15s;
}

.radio-item:hover {
  border-color: var(--accent-color);
}

.radio-item input[type='radio'] {
  margin-top: 3px;
}

.radio-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.radio-text strong {
  font-size: 13px;
}

.radio-text small {
  font-size: 11px;
  color: var(--text-secondary);
}

.toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.toggle-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.inline-input-row {
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.inline-field-label {
  flex: 1;
  min-width: 0;
}

.compact-number-input {
  flex: 0 0 120px !important;
  max-width: 120px;
}

.toggle-title {
  margin-bottom: 2px;
}

.toggle-description {
  margin-bottom: 0;
  max-width: 540px;
}

.toggle {
  position: relative;
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: #ccc;
  transition: background 0.2s;
  padding: 0;
}

.toggle.active {
  background: var(--accent-color);
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: white;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: transform 0.2s;
}

.toggle.active .toggle-thumb {
  transform: translateX(20px);
}

.toggle:disabled,
.toggle.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.permission-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.permission-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.permission-header .setting-label {
  margin-bottom: 0;
}

.permission-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.status-dot.green {
  background: var(--success-color);
}

.status-dot.red {
  background: var(--error-color);
}

.permission-granted {
  font-size: 12px;
  color: var(--success-color);
  font-weight: 500;
}

.api-key-row {
  display: flex;
  gap: 8px;
}

.api-key-row .input-field {
  flex: 1;
}

.prompt-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.preset-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.model-chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.model-custom-row {
  margin-top: 10px;
}

.preset-chip {
  padding: 6px 14px;
  border-radius: 20px;
  font-size: 13px;
  font-weight: 500;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  gap: 6px;
}

.preset-chip:hover {
  border-color: var(--accent-color);
}

.preset-chip.active {
  background: rgba(0, 113, 227, 0.1);
  border-color: var(--accent-color);
  color: var(--accent-color);
}

.preset-chip.preset-custom {
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.chip-delete {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  font-size: 12px;
  line-height: 1;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.chip-delete:hover {
  background: rgba(255, 59, 48, 0.15);
  color: #ff3b30;
}

.preset-chip.preset-add {
  border-style: dashed;
  color: var(--text-secondary);
}

.preset-badge {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(0, 113, 227, 0.1);
  color: var(--accent-color);
}

.preset-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.preset-name-input {
  max-width: 200px;
}

.btn-sm {
  padding: 4px 10px;
  font-size: 12px;
}

.btn-danger {
  color: var(--error-color);
  border-color: var(--error-color);
}

.btn-danger:hover {
  background: rgba(255, 59, 48, 0.1);
}

.slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.slider {
  flex: 1;
  -webkit-appearance: none;
  height: 4px;
  border-radius: 2px;
  background: #ddd;
  outline: none;
}

.slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: var(--accent-color);
  cursor: pointer;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
}

.slider-value {
  min-width: 28px;
  text-align: right;
  font-size: 13px;
  font-family: 'SF Mono', Menlo, monospace;
  color: var(--text-secondary);
}

.about-content {
  text-align: center;
  padding: 40px 0;
}

.about-app-name {
  font-size: 28px;
  font-weight: 700;
  margin-bottom: 4px;
}

.about-english-name {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 4px;
  letter-spacing: 0.5px;
}

.about-version {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 20px;
}

.about-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin-bottom: 16px;
  line-height: 1.6;
}

.about-author {
  font-size: 13px;
  color: var(--text-secondary);
  margin-top: 8px;
}

.update-section {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 20px;
  min-height: 32px;
}

.update-status-text {
  font-size: 13px;
  color: var(--text-secondary);
}

.update-status-ok {
  color: var(--success-color);
}

.update-status-error {
  color: var(--error-color);
  max-width: 300px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.update-progress-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  width: 200px;
}

.update-progress-bar {
  width: 100%;
  height: 6px;
  background: var(--border-color);
  border-radius: 3px;
  overflow: hidden;
}

.update-progress-fill {
  height: 100%;
  background: var(--accent-color);
  border-radius: 3px;
  transition: width 0.3s ease;
}

.save-toast {
  position: fixed;
  top: 48px;
  right: 24px;
  padding: 8px 18px;
  background: var(--success-color);
  color: #fff;
  border-radius: var(--radius);
  font-size: 13px;
  font-weight: 500;
  z-index: 200;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.toast-enter-active {
  transition: all 0.25s ease-out;
}
.toast-leave-active {
  transition: all 0.2s ease-in;
}
.toast-enter-from {
  opacity: 0;
  transform: translateY(-8px);
}
.toast-leave-to {
  opacity: 0;
}
.excluded-app-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.excluded-app-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  background: var(--bg-secondary);
  border-radius: 6px;
  font-size: 12px;
}

.empty-history {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary);
  font-size: 14px;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.history-item {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  padding: 16px;
}

.history-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-color);
}

.history-time {
  font-size: 12px;
  color: var(--text-secondary);
}

.history-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.history-original label,
.history-polished label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
  display: block;
}

.history-original p,
.history-polished p {
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0;
}

.history-polished p {
  color: var(--accent-color);
}

.selectable-text {
  user-select: text;
  cursor: text;
}

/* 双快捷键样式 */
.shortcut-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
}

.shortcut-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.shortcut-icon {
  font-size: 24px;
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  border-radius: 8px;
}

.shortcut-details {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shortcut-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.shortcut-desc {
  font-size: 12px;
  color: var(--text-secondary);
}

.shortcut-status {
  font-size: 11px;
  font-weight: 500;
}

.shortcut-status.ready {
  color: var(--success-color);
}

.shortcut-status.warning {
  color: var(--warning-color);
}

.shortcut-status.error {
  color: var(--error-color);
}

.shortcut-status.pending {
  color: var(--text-secondary);
}

.shortcut-control {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 模式切换 Tab 样式 */
.mode-tabs {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  padding: 4px;
  background: var(--bg-secondary);
  border-radius: var(--radius);
}

.mode-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 16px;
  border-radius: calc(var(--radius) - 2px);
  font-size: 13px;
  font-weight: 500;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: all 0.15s;
  color: var(--text-secondary);
}

.mode-tab:hover {
  background: rgba(0, 0, 0, 0.05);
}

.mode-tab.active {
  background: var(--bg-primary);
  color: var(--text-primary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.mode-tab .mode-icon {
  font-size: 16px;
}

.mode-tab .mode-shortcut {
  font-size: 11px;
  padding: 2px 6px;
  background: rgba(0, 0, 0, 0.05);
  border-radius: 4px;
  font-family: 'SF Mono', Menlo, monospace;
  color: var(--text-secondary);
}

.mode-tab.active .mode-shortcut {
  background: rgba(0, 113, 227, 0.1);
  color: var(--accent-color);
}

.mode-config {
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

/* 功能开关样式 - 横向排列紧凑版 */
.mode-toggles-inline {
  display: flex;
  gap: 8px;
}

.mode-toggle-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius);
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.mode-toggle-btn:hover {
  border-color: var(--accent-color);
}

.mode-toggle-btn.active {
  border-color: var(--accent-color);
  background: rgba(0, 113, 227, 0.1);
  color: var(--accent-color);
}

.mode-toggle-btn-icon {
  font-size: 14px;
}

/* 快捷键行禁用状态 */
.shortcut-row.disabled {
  opacity: 0.5;
  pointer-events: none;
}

.shortcut-row.disabled .shortcut-display {
  background: var(--bg-primary);
}

/* ============ Vocabulary (Memory Tab) ============ */
.vocab-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.vocab-toolbar-info {
  font-size: 12px;
  color: var(--text-secondary);
}

.vocab-toolbar-actions {
  display: flex;
  gap: 4px;
}

.vocab-add-form {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
  margin-bottom: 8px;
}

.vocab-input-term {
  flex: 2;
  min-width: 80px;
}

.vocab-input-desc {
  flex: 3;
  min-width: 100px;
}

.vocab-input-category {
  flex: 1;
  min-width: 70px;
}

.vocab-filter-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}

.filter-chip {
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-primary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
}

.filter-chip:hover {
  border-color: var(--accent-color);
}

.filter-chip.active {
  background: var(--accent-color);
  color: white;
  border-color: var(--accent-color);
}

.vocab-list-container {
  max-height: 380px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 8px;
}

.vocab-list {
  display: flex;
  flex-direction: column;
}

.vocab-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-color);
  transition: opacity 0.2s;
}

.vocab-item:last-child {
  border-bottom: none;
}

.vocab-item.disabled {
  opacity: 0.45;
}

.vocab-item-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.vocab-term {
  font-weight: 500;
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}

.vocab-category {
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--accent-color);
  color: white;
  white-space: nowrap;
  flex-shrink: 0;
}

.vocab-desc {
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 200px;
}

.vocab-item-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  margin-left: 6px;
}

.vocab-icon-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  padding: 0;
}

.vocab-icon-btn:hover {
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.vocab-icon-btn-danger:hover {
  color: var(--error-color);
}

.toggle-xs {
  width: 32px;
  height: 18px;
  border-radius: 9px;
}

.toggle-xs .toggle-thumb {
  width: 14px;
  height: 14px;
}

.toggle-xs.active .toggle-thumb {
  transform: translateX(14px);
}

.vocab-edit-row {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
  width: 100%;
  padding: 4px 0;
}

.vocab-edit-actions {
  display: flex;
  gap: 4px;
}

.vocab-empty {
  text-align: center;
  padding: 20px;
  color: var(--text-secondary);
  font-size: 13px;
}

.btn-sm {
  padding: 4px 12px;
  font-size: 12px;
}

.vocab-sync-result {
  font-size: 13px;
  color: var(--text-secondary);
}

.sync-source-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.sync-source-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border-radius: 6px;
  gap: 8px;
}

.sync-source-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}

.sync-source-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
}

.sync-source-url {
  font-size: 11px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sync-source-time {
  font-size: 11px;
  color: var(--text-tertiary);
}

.sync-source-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.sync-source-count {
  font-size: 11px;
  color: var(--text-tertiary);
}

.shared-source-group {
  margin-top: 4px;
}

.shared-source-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  gap: 8px;
  margin-bottom: 4px;
}

.shared-source-header .sync-source-info {
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

/* Shared source tabs */
.shared-source-tabs {
  display: flex;
  gap: 0;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--border-color);
  overflow-x: auto;
}

.shared-source-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}

.shared-source-tab:hover {
  color: var(--text-primary);
  background: rgba(0, 0, 0, 0.03);
}

.shared-source-tab.active {
  color: var(--accent-color);
  border-bottom-color: var(--accent-color);
}

.shared-source-tab-name {
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.shared-source-tab-count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.06);
  color: var(--text-secondary);
}

.shared-source-tab.active .shared-source-tab-count {
  background: rgba(0, 113, 227, 0.1);
  color: var(--accent-color);
}

.shared-source-content {
  animation: fadeIn 0.15s ease-out;
}

.shared-source-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  border-radius: 8px;
}

.shared-source-bar .sync-source-info {
  flex-direction: row;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}

</style>
