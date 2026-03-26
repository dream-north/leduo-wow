# ASR 词汇记忆功能实现方案

## Context

用户使用乐多汪汪进行语音输入时，ASR 经常将专有名词、产品名等识别错误（如同音字替换）。当前使用的 DashScope qwen3-asr-flash-realtime 模型的 WebSocket API **不支持热词/vocabulary 参数**（`session.update` 仅接受 `language`、`input_audio_format`、`sample_rate`、`turn_detection`），因此需要通过 **ASR 后处理** 方式实现词汇修正。

本方案新增"记忆"模块，包含：
1. 设置页新增"记忆"标签页，管理个人词库和共享词库
2. Pipeline 中 ASR 完成后、LLM 润色前插入词汇修正步骤
3. 支持本地 JSON 导入/导出和远程 URL 导入共享词库（含版本信息）

## 数据模型

### 新增类型 (`src/shared/types.ts`)

```typescript
interface VocabularyWord {
  word: string       // 正确的词
  enabled: boolean   // 是否启用
  addedAt: number    // 添加时间戳
}

interface VocabularyList {  // JSON 导入导出格式
  version: string
  updatedAt: number
  words: VocabularyWord[]
}
```

### AppConfig 扩展 (`src/shared/types.ts`)

在 `AppConfig` 接口和 `DEFAULT_CONFIG` 中新增：
- `vocabularyEnabled: boolean` — 总开关，默认 `true`
- `sharedVocabularyUrl: string` — 远程共享词库 URL，默认 `''`
- `sharedVocabularyVersion: string` — 已缓存共享词库版本，默认 `''`
- `sharedVocabularyUpdatedAt: number` — 上次同步时间戳，默认 `0`

### 独立存储 (`vocabulary.json`)

参照 `history.json` 的分离模式，词汇数据不放在 config.json 中，使用独立的 electron-store：
- `personalWords: VocabularyWord[]`
- `sharedWords: VocabularyWord[]`

## 核心模块

### 1. 词汇存储 — 新建 `src/main/vocabulary-store.ts`

参照 config-store.ts 中 historyStore 的模式，使用独立 electron-store（文件名 `vocabulary`）。

导出函数：
- `initVocabularyStore()` — 初始化 store
- `getPersonalVocabulary() / setPersonalVocabulary(words)`
- `addPersonalWord(word) / removePersonalWord(word) / togglePersonalWord(word, enabled)`
- `getSharedVocabulary() / setSharedVocabulary(words)`
- `getMergedEnabledWords(): string[]` — 合并 personal + shared 中 enabled=true 的词，去重后返回纯字符串数组（Pipeline 调用入口）

### 2. 词汇后处理器 — 新建 `src/main/vocabulary-processor.ts`

单一导出函数：`applyVocabulary(text: string, words: string[]): string`

**匹配算法：**

新增依赖 `pinyin-pro`（纯 JS，无 native 依赖，约 200KB）用于中文拼音匹配。

处理逻辑：
1. 将词汇词按字符长度降序排列（长词优先匹配，避免冲突）
2. 对每个词汇词 W：
   - **中文词**：将 W 转为无声调拼音序列，在 ASR 文本中用滑动窗口扫描等长子串，将每个子串也转拼音，拼音完全匹配但文字不同时替换为 W
   - **英文词**：对 ASR 文本做 case-insensitive 精确匹配替换（纠正大小写错误）
3. 函数是同步纯函数，不依赖存储细节

### 3. 词汇同步 — 新建 `src/main/vocabulary-sync.ts`

处理 JSON 文件导入/导出和远程 URL 下载：
- `importFromFile(filePath: string): Promise<VocabularyList>` — 读取本地 JSON
- `exportToFile(filePath: string, words: VocabularyWord[]): Promise<void>` — 导出标准 JSON
- `fetchFromUrl(url: string): Promise<VocabularyList>` — 通过 Electron `net.fetch` 下载 JSON

**JSON 格式验证：**
- 支持标准格式：`{ version, updatedAt, words: [{ word, enabled?, addedAt? }] }`
- 也支持简化格式：纯字符串数组 `["阿里巴巴", "Kubernetes"]`（自动转换）
- 导出始终使用标准格式

## Pipeline 集成

### 修改 `src/main/pipeline.ts` — `onASRComplete()` 方法

在第 257 行 `const config = getConfig(...)` 之后、第 259 行 `let outputText = text` 之前插入：

```typescript
// 保存原始 ASR 文本（用于历史记录）
const rawAsrText = text

// 词汇修正（ASR 后处理）
if (config.vocabularyEnabled) {
  const words = getMergedEnabledWords()
  if (words.length > 0) {
    text = applyVocabulary(text, words)
  }
}

let outputText = text
```

同时修改第 492 行 `originalText: text` 为 `originalText: rawAsrText`，确保历史记录保存纯 ASR 输出。

这样：
- `rawAsrText` = 纯 ASR 输出（写入历史 `originalText`）
- `text` = 词汇修正后的文本（传给 polisher / assistant）
- `outputText` = 最终输出（经过润色/助手处理）

## IPC 层

### 新增 IPC 通道 (`src/shared/ipc-channels.ts`)

```
VOCABULARY_GET_PERSONAL    'vocabulary:get-personal'
VOCABULARY_SET_PERSONAL    'vocabulary:set-personal'
VOCABULARY_ADD_WORD        'vocabulary:add-word'
VOCABULARY_REMOVE_WORD     'vocabulary:remove-word'
VOCABULARY_TOGGLE_WORD     'vocabulary:toggle-word'
VOCABULARY_GET_SHARED      'vocabulary:get-shared'
VOCABULARY_IMPORT_FILE     'vocabulary:import-file'
VOCABULARY_EXPORT_FILE     'vocabulary:export-file'
VOCABULARY_SYNC_SHARED     'vocabulary:sync-shared'
VOCABULARY_IMPORT_URL      'vocabulary:import-url'
```

### IPC Handler 注册 (`src/main/ipc-handlers.ts`)

注册上述 10 个 handler，模式与现有 config/history handler 一致（`ipcMain.handle`）。

文件导入/导出使用 `dialog.showOpenDialog` / `dialog.showSaveDialog`。

### Preload 层 (`src/preload/index.ts`)

在 `electronAPI` 中新增对应的 10 个方法，返回 `ipcRenderer.invoke(...)` 调用。

## Config 层修改

### `src/main/config-store.ts`

- `StoreSchema` 新增 4 个字段
- `initConfigStore` defaults 新增 4 个字段默认值
- `getConfig` 返回对象新增 4 个字段读取

### `src/renderer/src/stores/settings.ts`

新增 4 个 ref：`vocabularyEnabled`, `sharedVocabularyUrl`, `sharedVocabularyVersion`, `sharedVocabularyUpdatedAt`。在 `loadSettings` 中加载。

## 设置页 UI

### 修改 `src/renderer/src/views/SettingsView.vue`

新增"记忆"标签页（在 history 之前）：

```
┌─────────────────────────────────────────┐
│ 词汇记忆                                │
│                                         │
│ ┌─ 启用词汇修正 ───────── [toggle] ───┐ │
│ │ ASR 识别完成后自动使用词汇表修正文本  │ │
│ └─────────────────────────────────────┘ │
│                                         │
│ ┌─ 个人词汇 ─────────────────────────┐  │
│ │ [输入框: 输入词汇...] [添加]        │  │
│ │                                    │  │
│ │ ● 阿里巴巴    [✓] [×]             │  │
│ │ ● Kubernetes  [✓] [×]             │  │
│ │                                    │  │
│ │ [导入 JSON] [导出 JSON] 共 2 个词汇 │  │
│ └────────────────────────────────────┘  │
│                                         │
│ ┌─ 共享词汇 ─────────────────────────┐  │
│ │ 远程 URL: [__________] [同步]       │  │
│ │ 版本: 1.0.0  更新于: 2024-3-24     │  │
│ │ 已缓存 42 个词汇                    │  │
│ │ [从本地 JSON 导入]                  │  │
│ └────────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

复用现有 CSS 类（`.setting-group`, `.toggle-row`, `.input-field`, `.btn`）。词汇列表参照 `screenshotExcludedApps` 的列表样式（`.excluded-app-list` / `.excluded-app-item`）。

## 初始化

### 修改 `src/main/index.ts`

在 `app.whenReady` 的初始化流程中，在 `initConfigStore()` 之后调用 `initVocabularyStore()`。

## 实施步骤

| 步骤 | 操作 | 文件 |
|------|------|------|
| 1 | 新增类型定义 + AppConfig 扩展 + DEFAULT_CONFIG | `src/shared/types.ts` |
| 2 | 新增 IPC 通道常量 | `src/shared/ipc-channels.ts` |
| 3 | 新建词汇存储模块 | `src/main/vocabulary-store.ts` (新建) |
| 4 | 扩展 config store | `src/main/config-store.ts` |
| 5 | 安装 pinyin-pro | `npm install pinyin-pro` |
| 6 | 新建词汇后处理器 | `src/main/vocabulary-processor.ts` (新建) |
| 7 | 新建词汇同步模块 | `src/main/vocabulary-sync.ts` (新建) |
| 8 | Pipeline 集成 | `src/main/pipeline.ts` |
| 9 | IPC Handler 注册 | `src/main/ipc-handlers.ts` |
| 10 | Preload API 暴露 | `src/preload/index.ts` |
| 11 | 主进程初始化 | `src/main/index.ts` |
| 12 | Settings store 扩展 | `src/renderer/src/stores/settings.ts` |
| 13 | Settings UI 新增记忆标签页 | `src/renderer/src/views/SettingsView.vue` |

## 验证方案

1. **`npm run typecheck`** — 确认所有类型正确
2. **`npm run lint`** — 确认代码风格
3. **`npm run test`** — 运行现有测试
4. **`npm run dev`** 手动验证：
   - 设置页出现"记忆"标签页
   - 能添加/删除/开关词汇
   - 导入/导出 JSON 正常工作
   - 从 URL 导入共享词库正常（可用本地 HTTP server 测试）
   - 录音后 ASR 结果经过词汇修正（同音字被正确替换）
   - 历史记录中 `originalText` 保持原始 ASR 输出
