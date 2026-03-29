export enum PipelineStatus {
  IDLE = 'idle',
  RECORDING = 'recording',
  FINALIZING_ASR = 'finalizing_asr',
  ENHANCING_ASR = 'enhancing_asr',
  POLISHING = 'polishing',
  INPUTTING = 'inputting',
  CONVERSING = 'conversing',
  ERROR = 'error'
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

export type InputMethod = 'clipboard' | 'applescript'
export type AssistantOutputMode = 'input' | 'window'
export type OverlayVisualMode = 'recording' | 'processing' | 'success' | 'error'
export type OverlayResultFormat = 'markdown'
export type OverlayResultKind = 'assistant' | 'screen_doc'
export interface OverlayWindowPosition {
  x: number
  y: number
}

export interface OverlayWindowSize {
  width: number
  height: number
}
export type OverlayResultStatKind =
  | 'tokens-total'
  | 'tokens-thinking'
  | 'code-interpreter'
  | 'web-search'
  | 'web-extractor'

// 语音模式：语音识别 / 语音助手
export type VoiceMode = 'transcription' | 'assistant'
export type OverlayVoiceMode = VoiceMode | 'screen_doc'

export type ScreenDocStatus =
  | 'idle'
  | 'recording'
  | 'finalizing'
  | 'uploading'
  | 'analyzing'
  | 'ready'
  | 'error'

export interface ScreenDocStep {
  title: string
  description: string
  timestampMs: number
  screenshotTimestampMs: number
}

export interface ScreenDocAnalysis {
  title: string
  summary: string
  steps: ScreenDocStep[]
  notes: string[]
  transcript: string
}

export interface ScreenDocScreenshot {
  stepIndex: number
  timestampMs: number
  dataUrl: string
}

export interface ScreenDocResultPayload {
  artifactId: string
  analysis: ScreenDocAnalysis
  screenshots: ScreenDocScreenshot[]
  markdown: string
  createdAt: number
}

export interface ScreenDocStatusPayload {
  status: ScreenDocStatus
  startedAt?: number
  error?: string
  transcript?: string
  artifactId?: string
  stepCount?: number
  captureBackend?: 'native'
}

export interface OverlayHudPayload {
  text: string
  mode: OverlayVisualMode
  voiceMode: OverlayVoiceMode
  screenshotActive: boolean
}

export interface OverlayResultPayload {
  text: string
  format: OverlayResultFormat
  resultKind?: OverlayResultKind
  title?: string
  eyebrow?: string
  exportArtifactId?: string
  position?: OverlayWindowPosition
  size?: OverlayWindowSize
  detailsMarkdown?: string
  stats?: OverlayResultStat[]
  sources?: OverlayResultSource[]
  reasoningMarkdown?: string
  reasoningCollapsed?: boolean
  codeMarkdown?: string
  codeCollapsed?: boolean
  turnIndex?: number
  userMessage?: string
  isConversation?: boolean
  pipelineStatus?: string
}

export interface OverlayResultStat {
  kind: OverlayResultStatKind
  value: string
  detail: string
}

export interface OverlayResultSource {
  index: number
  title: string
  url: string
}

export interface PolishPreset {
  name: string
  prompt: string
  builtIn?: boolean
}

export type ApiProvider = 'dashscope' | 'custom'

export const ASR_DEFAULT_BASE_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime'
export const POLISH_DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1'
export const FLASH_ASR_DEFAULT_API_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
export const ASR_MODEL_PRESETS = ['qwen3-asr-flash-realtime'] as const
export const FLASH_ASR_MODEL_PRESETS = ['qwen3-asr-flash'] as const
export const TEXT_MODEL_PRESETS = ['qwen3.5-flash', 'qwen3.5-plus'] as const

export type VocabularySource = 'personal' | 'shared'

export interface VocabularyEntry {
  id: string
  term: string
  description: string
  category: string
  enabled: boolean
  createdAt: number
  updatedAt: number
  sourceUrl?: string
}

export interface SharedVocabSyncSource {
  name: string
  url: string
  lastSyncAt?: number
  writeToken?: string
}

export type GitPlatformType = 'github' | 'aone-code'

export interface GitPlatformInfo {
  platform: GitPlatformType
  owner: string
  repo: string
  branch: string
  filePath: string
}

/**
 * Parse a sync source URL into Git platform info.
 * Returns null if the URL doesn't match any supported platform.
 */
export function parseGitPlatformUrl(url: string): GitPlatformInfo | null {
  // GitHub raw: https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{path}
  const ghMatch = url.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/
  )
  if (ghMatch) {
    return {
      platform: 'github',
      owner: ghMatch[1],
      repo: ghMatch[2],
      branch: ghMatch[3],
      filePath: ghMatch[4]
    }
  }

  // Aone Code raw: https://code.alibaba-inc.com/{owner}/{repo}/raw/{branch}/{path}
  const aoneMatch = url.match(
    /^https?:\/\/code\.alibaba-inc\.com\/([^/]+)\/([^/]+)\/raw\/([^/?]+)\/([^?]+)/
  )
  if (aoneMatch) {
    return {
      platform: 'aone-code',
      owner: aoneMatch[1],
      repo: aoneMatch[2],
      branch: aoneMatch[3],
      filePath: aoneMatch[4]
    }
  }

  return null
}

export interface VocabMergeItem {
  term: string
  description: string
  category: string
  origin: 'personal' | 'remote' | 'both'
  conflict?: { personalDescription: string; personalCategory: string; remoteDescription: string; remoteCategory: string }
  selected: boolean
  resolution?: 'keep-personal' | 'keep-remote'
}

export interface VocabMergePreview {
  items: VocabMergeItem[]
  newCount: number
  conflictCount: number
  unchangedCount: number
  remoteOnlyCount: number
}

export const VOCABULARY_CATEGORY_PRESETS = [
  '人名',
  '产品',
  '团队',
  '技术',
  '公司',
  '行业',
  '地名',
  '其他'
] as const

export interface ExcludedApp {
  name: string
  bundleId: string
}

export interface AppConfig {
  apiKey: string // deprecated, kept for migration
  shortcut: string // deprecated, use transcriptionShortcut
  inputMethod: InputMethod
  // ASR config
  asrProvider: ApiProvider
  asrApiKey: string
  asrBaseUrl: string
  asrModel: string
  // Polish config (语音识别模式)
  polishEnabled: boolean
  polishProvider: ApiProvider
  polishApiKey: string
  polishModel: string
  polishBaseUrl: string
  polishPrompt: string
  polishPresets: PolishPreset[]
  activePresetIndex: number
  // 双模式配置 - 语音识别
  transcriptionShortcut: string
  transcriptionEnabled: boolean
  // 双模式配置 - 语音助手
  assistantShortcut: string
  assistantEnabled: boolean
  assistantPrePolish: boolean  // 是否先进行AI润色
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
  launchAtLogin: boolean
  selectedMicrophoneId: string
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
  sharedVocabSyncSources: SharedVocabSyncSource[]
  customModels: { asr: string[]; text: string[]; vocab: string[] }
  customVocabularyCategories: string[]
}

export interface TranscriptionRecord {
  id: string
  timestamp: number
  originalText: string
  polishedText: string
  mode?: VoiceMode // 记录使用的模式
}

export type ShortcutPermissionState = 'granted' | 'missing'
export type ShortcutBackendState = 'native' | 'fallback' | 'disabled'
export type ShortcutStatusReason =
  | 'ready'
  | 'permission_missing'
  | 'unsupported_without_accessibility'
  | 'shortcut_conflict'
  | 'backend_failed'

export interface ShortcutModeStatus {
  mode: VoiceMode
  shortcut: string
  backendState: ShortcutBackendState
  reason: ShortcutStatusReason
  requiresAccessibility: boolean
  canTriggerGlobally: boolean
}

export interface ShortcutServiceStatus {
  permissionState: ShortcutPermissionState
  backendState: ShortcutBackendState
  reason: ShortcutStatusReason
  modes: Record<VoiceMode, ShortcutModeStatus>
}

export const PRESET_STANDARD: PolishPreset = {
  name: '标准',
  builtIn: true,
  prompt:
    '你是一名文字润色助手，请不要直接回答语音识别出的问题，而是保持原意对语音识别文本进行润色。\n\n你的输入是：\n- user：用户语音识别的文本结果\n- image：屏幕截图（可能存在）\n\n\n具体要求如下：\n1. 仅输出润色后的文本，无需额外解释。\n2. 修正明显的语音识别错误；\n3. 保持原意和原文的语言习惯不变，使语句通顺自然，不要添加没有的内容。\n4. 根据屏幕截图（如有）对文本的用词进行修正。注意只对user的文本进行润色，不要直接将截图中的内容输出，也不是用图片的内容来回答用户的问题。\n5. 如果 user 字数很少（小于 5 个），不要扩写，保留原来的识别内容。\n\n特殊处理规则：\n- 改口处理：智能检测自我修正模式（如"不对"、"我是说"、"算了"）。删除被否定的前置内容，仅保留最终确认的信息。*示例*："预算是 50 万……不对……是 60 万" → "预算是 60 万。"\n- 逻辑重组：若说话人逻辑混乱或倒叙（如"先做 B，哦但在那之前要先做 A"），应按实际执行的时间逻辑调整语序。\n- 去噪处理：彻底删除无意义的口语填充词（如"那个"、"呃"、"你知道吧"），除非对语气有决定性影响。自动合并重复的词语或结巴（如"我……我觉得"→"我觉得"）。\n- 数字处理：所有数字统一使用阿拉伯数字。\n- 英文处理：输入英文时进行的修正，必要时做"点"-> \'.\' 的转换。\n- 句号处理：若文本明显为标题、课程名、标签、清单项或非完整句子结构，结尾不加句号。若为聊天内容或非结构化表达，结尾不加句号。'
}

export const PRESET_PRO: PolishPreset = {
  name: '正式',
  builtIn: true,
  prompt:
    '# 角色设定\n你是一名专业的文字润色助手，专门负责将语音识别（ASR）文本转化为通顺、准确、规范的书面文本。\n\n你的输入是：\n- user：用户语音识别的文本结果\n- image：屏幕截图（可能存在）\n\n请不要直接回答语音识别出的问题，而是对语音识别文本进行润色。\n\n# 核心原则\n1.  **仅输出结果**：只输出润色后的文本，严禁包含任何解释、注释或开场白。\n2.  **语言锁定**：输出语言必须与**原始口述内容**保持一致，严禁随指令语言改变（除非明确指示翻译）。\n3.  **原意保持**：在修正错误和优化表达时，必须严格保持原意和原文的语言习惯，不得随意增减信息。\n4.  **图像识别**：根据屏幕截图(如有)对文本的用词进行修正。注意只对user的文本进行润色，不要直接将截图中的内容输出，也不是用图片的内容来回答用户的问题。\n\n# 处理规则\n\n## 1. 文本修正与标准化\n*   **ASR 错误修正**：修正明显的同音字、错别字及语音识别错误。\n*   **数字规范**：所有数字统一转换为阿拉伯数字（如"一百"→"100"）。\n*   **数学表达**：算术逻辑转换为纯数学符号形式（如"三乘以五"→"3 × 5"），严禁数字与汉字混合。\n*   **标点转换**：\n    *   将口述标点（"逗号"、"句号"、"冒号"等）转换为对应符号。\n    *   修复伪断句：识别 ASR 在动词后错误添加的逗号及随后的标点名称，将其合并为正确标点（如"他说，冒号"→"他说："）。\n    *   英文标点：输入英文时，将口述的"点"转换为"。"。\n*   **排版规范**：\n    *   **盘古之白**：中文与英文、中文与数字之间必须添加一个空格（如"使用 React"、"快 4 倍"）。\n    *   **大小写**：英文专有名词必须使用官方标准大小写（如 iOS, MySQL, GitHub）。\n    *   **英文保留**：原文中的英文单词、缩写禁止翻译成中文，仅修正拼写。\n\n## 2. 语义与逻辑优化\n*   **改口处理**：智能检测自我修正模式（如"不对"、"我是说"、"算了"）。删除被否定的前置内容，仅保留最终确认的信息。\n    *   *示例*："预算是 50 万……不对……是 60 万" → "预算是 60 万。"\n*   **逻辑重组**：若说话人逻辑混乱或倒叙（如"先做 B，哦但在那之前要先做 A"），应按实际执行的时间逻辑调整语序。\n*   **去噪处理**：\n    *   彻底删除无意义的口语填充词（如"那个"、"呃"、"你知道吧"），除非对语气有决定性影响。\n    *   自动合并重复的词语或结巴（如"我……我觉得"→"我觉得"）。\n*   **风格润色**：将过于琐碎或粗俗的口语词汇润色为得体的书面表达（如"搞一下"→"处理"），但不得改变原意。\n\n## 3. 结构与格式\n*   **列表结构化**：当识别到文本中包含 3 个及以上连续动作、步骤、建议或并列观点时（特征词：首先/然后/第一/第二……），必须使用 Markdown 有序或无序列表输出，每一步换行。\n    *   *例外*：若仅为描述连续心理活动、快速动作流或紧凑叙事，强行拆分破坏流畅性时，保持段落结构。\n*   **结尾标点**：\n    *   若文本明显为标题、课程名、标签、清单项或非完整句子结构，严禁强行添加句号。\n    *   若为聊天内容或非结构化表达，结尾严禁强行添加句号。\n*   **指令响应**：若用户明确指示格式（如"发给某人"、"整理成邮件"），请生成符合该场景惯例的格式（如邮件头、问候语），并智能移除无关的口语起手式。\n\n## 4. 术语与词典\n*   **用户词典优先**：若出现与【用户词典】发音、拼写或语义相似的词，强制替换为词典中的标准形式，严格保持词典定义的大小写。\n*   **技术术语修复**：根据上下文修正音译错误（如"瑞艾克特"→"React"，"VS 扣的"→"VS Code"，"扎瓦"→"Java"）。'
}

export const BUILTIN_PRESETS: PolishPreset[] = [PRESET_STANDARD, PRESET_PRO]

// 语音助手默认提示词
export const ASSISTANT_DEFAULT_PROMPT = `你是一名语音助手，负责直接回答用户的问题。

输入
- 选中的文本（可能有）
- 屏幕截图（可能有）
- user的问题

回答要求
- 直接给出问题的答案，不要给出"好的，没问题，根据..."的字样`

// 语音助手内置预设
export const ASSISTANT_PRESET_STANDARD: PolishPreset = {
  name: '标准助手',
  builtIn: true,
  prompt: ASSISTANT_DEFAULT_PROMPT
}

export const ASSISTANT_BUILTIN_PRESETS: PolishPreset[] = [ASSISTANT_PRESET_STANDARD]

// Vocabulary prompt template
export const VOCAB_PROMPT_DEFAULT_TEMPLATE = `以下是词汇表，请尽量进行匹配和替换：\n\n{vocabulary_list}\n\n你是一名文字润色助手，请不要直接回答语音识别出的问题，而是保持原意对语音识别文本进行润色。`

export const VOCAB_PROMPT_PRESET_STANDARD: PolishPreset = {
  name: '标准',
  builtIn: true,
  prompt: VOCAB_PROMPT_DEFAULT_TEMPLATE
}

export const VOCAB_PROMPT_BUILTIN_PRESETS: PolishPreset[] = [VOCAB_PROMPT_PRESET_STANDARD]

function getRuntimePlatform(): NodeJS.Platform {
  if (typeof process !== 'undefined' && typeof process.platform === 'string') {
    return process.platform as NodeJS.Platform
  }

  return 'darwin'
}

export function getDefaultTranscriptionShortcut(platform: NodeJS.Platform = getRuntimePlatform()): string {
  return platform === 'win32' ? 'RightAlt+.' : 'RightCommand'
}

export function getDefaultAssistantShortcut(platform: NodeJS.Platform = getRuntimePlatform()): string {
  return platform === 'win32' ? 'RightAlt+/' : 'RightOption'
}

export const DEFAULT_CONFIG: AppConfig = {
  apiKey: '',
  shortcut: getDefaultTranscriptionShortcut(),
  inputMethod: 'clipboard',
  // ASR
  asrProvider: 'dashscope',
  asrApiKey: '',
  asrBaseUrl: ASR_DEFAULT_BASE_URL,
  asrModel: 'qwen3-asr-flash-realtime',
  // Polish (语音识别模式)
  polishEnabled: true,
  polishProvider: 'dashscope',
  polishApiKey: '',
  polishModel: 'qwen3.5-flash',
  polishBaseUrl: POLISH_DEFAULT_BASE_URL,
  polishPrompt: PRESET_STANDARD.prompt,
  polishPresets: [...BUILTIN_PRESETS],
  activePresetIndex: 0,
  // 双模式配置 - 语音识别
  transcriptionShortcut: getDefaultTranscriptionShortcut(),
  transcriptionEnabled: true,
  // 双模式配置 - 语音助手
  assistantShortcut: getDefaultAssistantShortcut(),
  assistantEnabled: true,
  assistantPrePolish: true,  // 默认先润色再处理
  assistantOutputMode: 'window',
  assistantModel: 'qwen3.5-flash',
  assistantEnableThinking: false,
  assistantThinkingBudget: 256,
  assistantEnableSearch: false,
  assistantEnableCodeInterpreter: false,
  assistantPrompt: ASSISTANT_DEFAULT_PROMPT,
  assistantPresets: [...ASSISTANT_BUILTIN_PRESETS],
  assistantActivePresetIndex: 0,
  assistantResultWindowPosition: undefined,
  assistantResultWindowSize: undefined,
  // General
  selectedMicrophoneId: '',
  launchAtLogin: false,
  overlayPosition: 'bottom',
  audioThreshold: 0,
  screenshotEnabled: false,
  screenshotSavePath: '',
  screenshotMaxCount: 30,
  screenshotExcludedApps: [],
  hideDockIcon: false,
  historyMaxCount: 50,
  // Vocabulary enhancement
  vocabularyEnabled: true,
  vocabularyModel: 'qwen3-asr-flash',
  vocabularyPrompt: VOCAB_PROMPT_DEFAULT_TEMPLATE,
  vocabularyPromptPresets: [...VOCAB_PROMPT_BUILTIN_PRESETS],
  vocabularyPromptActivePresetIndex: 0,
  vocabularyInPolish: false,
  sharedVocabularySyncUrl: '',
  sharedVocabularySyncToken: '',
  sharedVocabSyncSources: [] as SharedVocabSyncSource[],
  customModels: { asr: [], text: [], vocab: [] },
  customVocabularyCategories: [] as string[]
}

// Auto-update types
export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'not-available' | 'error'

export interface UpdateStatusPayload {
  status: UpdateStatus
  currentVersion: string
  newVersion?: string
  releaseNotes?: string
  progress?: number
  error?: string
}
