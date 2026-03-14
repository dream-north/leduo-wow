# AGENTS.md

本文件为 Codex 在本仓库中的工作说明，内容基于当前代码实现整理，用于替代 `CLAUDE.md`。

## 项目概览

乐多汪汪（Leduo Wow）是一个 macOS 菜单栏语音输入工具，技术栈为 Electron + Vue 3 + Pinia。

核心能力：

- 全局快捷键唤起录音
- 调用 DashScope 风格实时 ASR 做语音转文字
- 可选地调用 OpenAI 兼容 LLM 做润色或回答
- 将结果自动输入到当前前台应用
- 用悬浮窗体系展示录音、处理中和结果状态

当前实现已经不是单一“语音转写”模式，而是双模式：

- `transcription`：语音识别 / 可选润色 / 自动输入
- `assistant`：语音识别 / 可选预润色 / 结合选中文本与截图让 LLM 直接回答 / 自动输入或独立结果窗输出

悬浮窗体系长期统一到 native overlay subsystem：

- 录音状态 HUD：优先由 macOS native helper 展示
- 助手结果窗：优先由 macOS native helper 展示 Markdown 结果
- BrowserWindow Overlay 仅作为 fallback / 过渡实现，不是长期主路径

## 常用命令

```bash
# 开发
npm run dev

# 构建
npm run build
npm run build:native
npm run pack
./build.sh

# 质量检查
npm run typecheck
npm run lint
```

说明：

- `postinstall` 会自动执行 `electron-builder install-app-deps` 和原生 Swift 键盘监听器构建
- 原生快捷键监听器位于 `src/native-keyboard-listener/SwiftKeyboardListener/`

## 运行与权限模型

这是一个 macOS menubar app。应用启动后常驻，不会因为关闭窗口退出。

关键权限：

- 辅助功能权限：全局快捷键监听、文本输入模拟所必需
- 麦克风权限：Overlay 窗口内进行录音所必需
- 屏幕录制权限：开启截图上下文时所必需

当前实现会在设置窗口顶层做权限闸门：

- 麦克风权限和辅助功能权限是必需项
- 屏幕录制权限是可选项
- 缺少必需权限时显示 onboarding，而不是退出 App
- 辅助功能权限授予后会在应用内热刷新快捷键后端，不要求用户重启 App

## 进程与窗口结构

### 主进程

入口：`src/main/index.ts`

负责：

- 初始化配置与历史存储
- 权限检查
- 创建设置窗口与 fallback BrowserWindow Overlay
- 初始化 `Pipeline`
- 初始化 `OverlayManager`
- 初始化 `ShortcutService`
- 注册 IPC
- 创建托盘与控制 Dock 图标显示

### 设置窗口

- 页面入口：`src/renderer/src/main.ts`
- 主视图：`src/renderer/src/views/SettingsView.vue`
- 状态管理：`src/renderer/src/stores/settings.ts`
- 预加载：`src/preload/index.ts`

负责配置：

- ASR 与 LLM 接口
- 双快捷键录制
- 双模式开关与提示词
- 输入方式、麦克风、音量阈值
- 截图能力、截图保存目录、排除应用
- Launch at Login、Dock 图标、历史记录上限

设置窗口顶层包含强阻断 onboarding：

- 未授予麦克风或辅助功能权限时，先进入 onboarding
- 授权完成后再进入主设置页
- 如果运行中权限被撤销，重新聚焦窗口时会再次进入 onboarding

### Native Overlay Backend

- TS bridge：`src/native-keyboard-listener/index.ts`
- macOS native 实现：`src/native-keyboard-listener/SwiftKeyboardListener/Sources/main.swift`

负责：

- 复用现有 Swift helper 进程承接快捷键监听与原生浮窗展示
- 展示录音状态 HUD
- 展示助手结果窗
- 以平台无关的 overlay payload 与主进程通信

约束：

- Electron main 负责业务编排，native helper 只负责快捷键监听与浮窗展示
- 录音 HUD 与助手结果窗必须共用同一套 overlay backend 抽象
- 不要把 AppKit / `NSPanel` 等平台细节泄漏到 `Pipeline`、共享类型或设置页

### BrowserWindow Overlay（Fallback）

- 创建：`src/main/overlay-window.ts`
- 页面入口：`src/renderer/overlay/main.ts`
- 主组件：`src/renderer/overlay/Overlay.vue`
- 预加载：`src/preload/overlay.ts`

负责：

- 使用 Web Audio API 采集 16k 单声道音频
- 以阈值过滤低音量帧
- 把 PCM 数据通过 IPC 发回主进程
- 展示录音中、处理中、成功、错误状态
- 展示当前模式以及截图激活状态

说明：

- 这是 Electron fallback / 过渡实现，不应继续扩展成长期主路径
- 如果 native overlay 可用，运行时应优先使用 native backend

## 核心架构

### Pipeline

文件：`src/main/pipeline.ts`

`Pipeline` 是整个产品的编排中心，状态枚举定义在 `src/shared/types.ts`：

```text
IDLE -> RECORDING -> FINALIZING_ASR -> POLISHING -> INPUTTING -> IDLE
```

另外还有 `ERROR` 状态。

行为要点：

- 热键触发时，如果当前是 `IDLE`，进入录音
- 如果当前是 `RECORDING`，停止录音并结束 ASR
- 如果当前已经在识别、润色或输入阶段，再按热键会强制取消并重置
- `Esc` 在录音期间会取消当前流程
- `Pipeline` 只通过 `OverlayBackend` / `OverlayManager` 驱动浮窗，不直接依赖 `BrowserWindow` 或某个平台原生窗口实现

### 双模式流程

#### `transcription`

流程：

1. Overlay 开始录音
2. `ASRClient` 持续接收 partial 文本
3. 停止录音后等待 ASR completed
4. 若开启 `polishEnabled` 且已配置 `polishApiKey`，调用 `LLMPolisher`
5. 通过 `TextInputter` 自动输入到前台 App
6. 写入历史

#### `assistant`

流程：

1. Overlay 开始录音
2. ASR 完成后得到用户语音文本
3. 若开启 `assistantPrePolish`，先使用转写润色提示词做预处理
4. 读取当前选中文本 `src/main/selected-text.ts`
5. 若开启截图，上下文中附带当前屏幕截图
6. 使用 `assistantPrompt` 调用 LLM 直接生成回答
7. 按配置自动输入到前台 App，或显示独立助手结果窗
8. 写入历史

### Overlay Backend 抽象

文件：

- `src/main/overlay-backend.ts`
- `src/main/overlay-manager.ts`
- `src/main/mac-native-overlay-backend.ts`
- `src/main/electron-overlay-backend.ts`

职责：

- 为业务层提供统一的 HUD / 结果窗接口
- 在 macOS 优先选择 native backend
- native backend 不可用时回退到 Electron fallback backend

约束：

- 业务层只依赖平台无关的 overlay payload 与接口
- 不要在 `Pipeline` 中重新接回某个具体窗口实现
- 新增平台能力时，应通过新增 backend 接入，而不是污染业务逻辑

### 截图上下文

截图逻辑在 `src/main/pipeline.ts`。

当前实现要点：

- `assistant` 模式默认需要截图上下文
- `transcription` 模式仅在开启润色时才可能需要截图
- 是否真的截图还受 `screenshotEnabled` 控制
- 录音期间会轮询前台 App
- 如果前台 App 在 `screenshotExcludedApps` 中，则临时禁用截图
- 停止录音时抓取“光标所在屏幕”的截图，而不是固定主屏
- 可选保存截图到本地目录，并按 `screenshotMaxCount` 清理旧文件

## 核心模块

### ASRClient

文件：`src/main/asr-client.ts`

职责：

- 连接 DashScope 风格实时 WebSocket ASR
- 使用 `session.update` 配置会话
- 在连接尚未 ready 时缓存音频 chunk
- 发送 `input_audio_buffer.append`
- 结束时发送 `input_audio_buffer.commit` 和 `session.finish`
- 输出 `partial`、`completed`、`error` 事件

默认模型与地址定义在 `src/shared/types.ts`：

- ASR base URL：`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`
- ASR model：`qwen3-asr-flash-realtime`

### LLMPolisher

文件：`src/main/llm-polisher.ts`

职责：

- 调用 OpenAI 兼容 `/chat/completions`
- 支持普通请求与流式请求
- 支持把截图以 `image_url` 形式拼进多模态输入
- 目前同时用于“文本润色”和“语音助手回答”

默认模型与地址：

- Polish base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- Polish model：`qwen3.5-flash`

### TextInputter

文件：`src/main/text-inputter.ts`

职责：

- 把最终文本输入回前台应用

实现策略：

- `clipboard`：优先方案，写入剪贴板后用 `Cmd+V`
- `applescript`：ASCII 短文本可尝试逐字输入
- 如果存在中文、非 ASCII 或长文本，会自动回退到剪贴板方案
- 优先使用 `@jitsi/robotjs`，不可用时回退到 `osascript`

### ShortcutService

文件：`src/main/shortcut.ts`

职责：

- 统一管理快捷键配置、权限状态与后端切换
- 当前有两类后端：
  - `MacNativeShortcutBackend`：Swift 原生监听器，支持左右修饰键和 modifier-only 快捷键
  - `GlobalShortcutFallbackBackend`：Electron `globalShortcut`，作为无辅助功能权限时的兼容兜底
- 在辅助功能权限变化时热切换 native / fallback backend
- 为 renderer 提供统一的快捷键状态模型
- 处理全局热键触发与录音中的 `Esc` 取消

默认快捷键：

- 转写：`RightCommand`
- 助手：`RightOption`

兼容规则：

- 左右修饰键识别和 modifier-only 快捷键属于 native backend 能力
- 通用组合键是跨平台最小保证能力
- 无辅助功能权限时，如果快捷键不属于 fallback 可支持的组合，则仅显示“已配置但当前不可全局触发”

### 配置与历史存储

文件：`src/main/config-store.ts`

存储策略：

- `config.json`：应用配置
- `history.json`：历史记录

已经存在的迁移逻辑：

- 旧版加密 `apiKey` 迁移到 `asrApiKey` / `polishApiKey`
- 旧版 `shortcut` 迁移到 `transcriptionShortcut`
- 历史记录从旧 `config.json` 迁移到独立 `history.json`

## 共享定义

关键共享文件：

- `src/shared/types.ts`：状态、配置、预设、默认值、模式定义
- `src/shared/ipc-channels.ts`：所有 IPC channel 名称

重要类型：

- `PipelineStatus`
- `VoiceMode`
- `AppConfig`
- `OverlayHudPayload`
- `OverlayResultPayload`
- `PolishPreset`
- `ExcludedApp`

## IPC 边界

### 设置窗口预加载 API

文件：`src/preload/index.ts`

主要能力：

- 读取 / 写入配置
- 请求权限
- 开始 / 结束快捷键录制
- 订阅 pipeline 状态、partial text、final text、error
- 读取历史记录
- 打开目录选择器
- 打开 Finder 路径
- 获取运行中的 App 列表

### Overlay 预加载 API

文件：`src/preload/overlay.ts`

主要能力：

- 接收 Overlay 文案与模式更新
- 接收开始 / 停止录音指令
- 上报音频 chunk
- 上报录音错误
- 接收实时音量阈值更新

## 构建配置

### electron-vite

文件：`electron.vite.config.ts`

构建分为三段：

- `main`
- `preload`
- `renderer`

当前入口：

- preload: `src/preload/index.ts`, `src/preload/overlay.ts`
- renderer: `src/renderer/index.html`, `src/renderer/overlay.html`

路径别名：

- `@main` -> `src/main`
- `@renderer` -> `src/renderer/src`
- `@shared` -> `src/shared`

### electron-builder

文件：`electron-builder.yml`

要点：

- 仅打 macOS 包
- 产物为 `dmg` 和 `zip`
- `afterPack` 钩子：`build/afterPack.js`
- 把 SwiftKeyboardListener 二进制打进 `extraResources`
- 启用 Hardened Runtime
- 配置麦克风与屏幕录制权限说明

## 关键文件定位

| 用途 | 路径 |
|------|------|
| 主进程入口 | `src/main/index.ts` |
| Pipeline 编排 | `src/main/pipeline.ts` |
| IPC 注册 | `src/main/ipc-handlers.ts` |
| 配置存储 | `src/main/config-store.ts` |
| 全局快捷键管理 | `src/main/shortcut.ts` |
| ASR 客户端 | `src/main/asr-client.ts` |
| LLM 调用 | `src/main/llm-polisher.ts` |
| 文本输入 | `src/main/text-inputter.ts` |
| Overlay 抽象接口 | `src/main/overlay-backend.ts` |
| Overlay 管理器 | `src/main/overlay-manager.ts` |
| macOS native overlay backend | `src/main/mac-native-overlay-backend.ts` |
| Electron overlay fallback backend | `src/main/electron-overlay-backend.ts` |
| 悬浮窗创建 | `src/main/overlay-window.ts` |
| 助手结果窗 fallback | `src/main/assistant-result-window.ts` |
| 权限检查 | `src/main/permissions.ts` |
| 选中文本读取 | `src/main/selected-text.ts` |
| 托盘 | `src/main/tray.ts` |
| 原生快捷键与 overlay bridge | `src/native-keyboard-listener/index.ts` |
| Swift 键盘监听器与 native overlay | `src/native-keyboard-listener/SwiftKeyboardListener/Sources/main.swift` |
| 设置页 | `src/renderer/src/views/SettingsView.vue` |
| 设置状态 | `src/renderer/src/stores/settings.ts` |
| Overlay 组件 | `src/renderer/overlay/Overlay.vue` |
| 设置窗口 preload | `src/preload/index.ts` |
| Overlay preload | `src/preload/overlay.ts` |
| 共享类型 | `src/shared/types.ts` |
| IPC 常量 | `src/shared/ipc-channels.ts` |

## 修改代码时的注意点

- 这是 macOS-only 应用，很多能力依赖系统权限与 AppleScript / CGEvent
- 快捷键系统必须通过统一 backend 抽象接入，不要让业务代码直接依赖某个平台原生监听器
- “快捷键录制”和“全局快捷键触发”是两个独立能力；录制逻辑不得依赖 native backend
- 不要把 Electron `globalShortcut` 当成唯一实现；它只是 fallback backend
- Overlay 展示必须通过统一 `OverlayBackend` / `OverlayManager` 接入，不要在业务代码里直接操作 `BrowserWindow` 或 Swift helper
- 录音 HUD 与助手结果窗必须共用同一套 overlay backend，而不是两条独立实现链路
- BrowserWindow Overlay 是 fallback / 过渡实现；native overlay 是长期主路径
- overlay 音频采集仍可留在 renderer fallback 中，但 ASR 编排与浮窗状态驱动都在 main 进程，修改时不要混淆职责边界
- `assistant` 与 `transcription` 两套配置是并存的，改动时要检查两条链路
- 旧配置迁移逻辑已存在，新增配置项时要同步更新：
  - `StoreSchema`
  - `DEFAULT_CONFIG`
  - `getConfig()`
  - 设置页 store
  - 设置页 UI
- 历史记录更新依赖 `IPC.HISTORY_UPDATED` 广播
- Dock 图标显示是有节流和锁状态通知的，不要直接随意改 `app.dock.show/hide`

## 跨平台约束

虽然当前产品仍以 macOS 为主，但快捷键系统与 overlay 系统都需要为 Windows 预留抽象层：

- 配置层继续保存统一的快捷键字符串，不写死 macOS-only 语义到业务层
- 平台差异下沉到 backend capability，而不是 UI 或 Pipeline
- overlay 接口层必须平台无关，不把 `NSPanel`、`fullScreenAuxiliary`、`screen-saver` 等术语写入共享类型与业务层
- “当前屏幕”是产品语义，统一定义为 cursor display，不绑定某个平台 API 名称
- 全屏置顶能力由 backend 自行实现，不在共享逻辑中写死平台策略
- Windows 第一阶段只要求支持通用全局组合键
- Windows overlay backend 未来应实现与 macOS 相同的产品语义：
  - HUD 显示 / 隐藏 / 更新
  - 结果窗显示 / 复制 / 关闭 / 拖动
  - 当前屏幕定位
  - `assistantOutputMode` 语义一致
- 如果未来 Windows 也要支持左右修饰键，再单独新增 Windows native backend；不要污染 fallback 语义

## Native Overlay 设计守则

- 录音 HUD：轻量、不可交互、光标所在屏幕、全屏可见优先
- 助手结果窗：可交互、可复制、可关闭、可拖动、支持 Markdown 富文本
- 两类浮窗统一视觉语言，但职责分离；不要为了复用而牺牲交互边界
- native helper 构建产物继续忽略，不提交编译后的二进制

## 替代关系

本仓库以后以 `AGENTS.md` 作为代理说明入口；`CLAUDE.md` 是旧文件，不应再继续维护。
