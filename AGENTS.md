# AGENTS.md

本文件为 Codex 在本仓库中的工作说明，内容基于当前代码实现整理，用于替代 `CLAUDE.md`。

## 项目概览

乐多汪汪（Leduo Wow）是一个多平台语音输入与语音助手应用，技术栈为 Electron + Vue 3 + Pinia，当前支持 macOS 和 Windows。

核心能力：

- 全局快捷键唤起录音
- 调用 DashScope 风格实时 ASR 做语音转文字
- 可选调用 OpenAI 兼容 LLM 做润色或直接回答
- 将结果自动输入到当前前台应用
- 用悬浮窗体系展示录音、处理中和结果状态

当前实现不是单一“语音转写”模式，而是双模式：

- `transcription`：语音识别 / 可选润色 / 自动输入
- `assistant`：语音识别 / 可选预润色 / 结合选中文本与截图让 LLM 直接回答 / 自动输入或独立结果窗输出

悬浮窗体系统一到 overlay backend abstraction：

- 录音状态 HUD
- 助手结果窗
- BrowserWindow Overlay 仍然存在，但只是 backend 之一，不应直接被业务层依赖

## 常用命令

```bash
# 开发
npm run dev

# 构建
npm run build
npm run build:native
npm run pack
npm run pack:win
./build.sh
.\build-win.ps1

# 质量检查
npm run typecheck
npm run lint
npm run test
```

说明：

- `postinstall` 会自动执行原生依赖准备与 native helper 构建
- 原生快捷键监听器位于 `src/native-keyboard-listener/`
- Windows 双击打包入口为仓库根目录下的 `build-win.cmd`

## 平台与权限模型

### macOS

- menubar app 体验优先
- 必需权限：麦克风、辅助功能
- 可选权限：屏幕录制（截图上下文）
- 快捷键与 overlay 优先走 native helper

### Windows

- tray / 独立窗口体验优先
- 必需条件：麦克风、全局快捷键可用
- 不使用 macOS 的辅助功能权限语义
- 结果窗与录音 HUD 当前主要走 Electron overlay backend
- 快捷键监听使用 Windows 原生 helper，支持右侧修饰键

当前设置窗口会在顶层做权限与能力闸门：

- 缺少必需项时进入 onboarding
- macOS 主要校验麦克风与辅助功能权限
- Windows 主要校验麦克风与快捷键是否可全局触发
- 运行中权限或快捷键能力变化时会热刷新状态

## 进程与窗口结构

### 主进程

入口：`src/main/index.ts`

负责：

- 初始化配置与历史存储
- 权限检查
- 创建设置窗口、录音 HUD、助手结果窗
- 初始化 `Pipeline`
- 初始化 `OverlayManager`
- 初始化 `ShortcutService`
- 注册 IPC
- 创建托盘与平台相关窗口行为控制

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
- Launch at Login、Dock / 托盘相关行为、历史记录上限

### Overlay Backend

关键文件：

- `src/main/overlay-backend.ts`
- `src/main/overlay-manager.ts`
- `src/main/mac-native-overlay-backend.ts`
- `src/main/electron-overlay-backend.ts`

职责：

- 为业务层提供统一 HUD / 结果窗接口
- macOS 优先选择 native backend
- native backend 不可用时回退到 Electron backend
- Windows 目前主要由 Electron backend 承接浮窗展示

约束：

- 业务层只依赖平台无关的 overlay payload 与接口
- 不要在 `Pipeline` 中直接操作具体窗口实现
- 新增平台能力应通过新增 backend 接入，而不是污染业务层

### Native Keyboard Listener

- TS bridge：`src/native-keyboard-listener/index.ts`
- macOS native 实现：`src/native-keyboard-listener/SwiftKeyboardListener/Sources/main.swift`
- Windows native 实现：`src/native-keyboard-listener/WinKeyServer/`

负责：

- 全局快捷键监听
- 左右修饰键识别与 modifier-only 快捷键支持
- 与主进程通信，承接平台原生能力

## 核心架构

### Pipeline

文件：`src/main/pipeline.ts`

状态机定义在 `src/shared/types.ts`：

```text
IDLE -> RECORDING -> FINALIZING_ASR -> POLISHING -> INPUTTING -> IDLE
```

另有 `ERROR` 状态。

行为要点：

- `IDLE` 下按热键进入录音
- `RECORDING` 下按热键结束录音并结束 ASR
- 处理中再次按热键会强制取消并重置
- `Esc` 在录音期间会取消当前流程
- `Pipeline` 只通过 `OverlayBackend` / `OverlayManager` 驱动浮窗

### 双模式流程

#### `transcription`

1. Overlay 开始录音
2. `ASRClient` 持续输出 partial 文本
3. 停止录音后等待 ASR completed
4. 若开启 `polishEnabled` 且已配置 `polishApiKey`，调用 `LLMPolisher`
5. 通过 `TextInputter` 自动输入到前台应用
6. 写入历史

#### `assistant`

1. Overlay 开始录音
2. ASR 完成后得到用户语音文本
3. 若开启 `assistantPrePolish`，先做预润色
4. 读取当前选中文本 `src/main/selected-text.ts`
5. 若开启截图，上下文中附带当前屏幕截图
6. 使用 `assistantPrompt` 调用 LLM 直接生成回答
7. 按配置自动输入到前台应用，或显示独立助手结果窗
8. 写入历史

### 截图上下文

截图逻辑位于 `src/main/pipeline.ts`。

实现要点：

- `assistant` 模式默认支持截图上下文
- `transcription` 模式仅在开启润色时可能需要截图
- 是否真的截图受 `screenshotEnabled` 控制
- 录音期间会轮询前台 App
- 如果前台 App 在 `screenshotExcludedApps` 中，则临时禁用截图
- 停止录音时抓取“光标所在屏幕”的截图
- 可选保存截图到本地目录，并按 `screenshotMaxCount` 清理旧文件

## 核心模块

### ASRClient

文件：`src/main/asr-client.ts`

职责：

- 连接 DashScope 风格实时 WebSocket ASR
- 使用 `session.update` 配置会话
- 在连接未 ready 时缓存音频 chunk
- 发送 `input_audio_buffer.append`
- 结束时发送 `input_audio_buffer.commit` 和 `session.finish`
- 输出 `partial`、`completed`、`error` 事件

默认值定义在 `src/shared/types.ts`：

- ASR base URL：`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`
- ASR model：`qwen3-asr-flash-realtime`

### LLMPolisher

文件：`src/main/llm-polisher.ts`

职责：

- 调用 OpenAI 兼容 `/chat/completions`
- 支持普通请求与流式请求
- 支持把截图以 `image_url` 形式拼入多模态输入
- 同时用于“文本润色”和“语音助手回答”

默认值：

- Polish base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- Polish model：`qwen3.5-flash`

### TextInputter

文件：`src/main/text-inputter.ts`

职责：

- 把最终文本输入回前台应用

实现策略：

- `clipboard`：优先方案，写入剪贴板后再粘贴
- `applescript`：仅 macOS 支持，ASCII 短文本可尝试逐字输入
- Windows 不暴露 AppleScript 输入方式
- 优先使用 `@jitsi/robotjs`，不可用时再做平台化 fallback

### ShortcutService

文件：`src/main/shortcut.ts`

职责：

- 统一管理快捷键配置、权限状态与后端切换
- 提供统一的快捷键状态模型给 renderer
- 处理全局热键触发与录音中的 `Esc` 取消

当前后端：

- `MacNativeShortcutBackend`
- `WindowsNativeShortcutBackend`
- `GlobalShortcutFallbackBackend`

默认快捷键：

- macOS：转写 `RightCommand`，助手 `RightOption`
- Windows：转写 `RightAlt`，助手 `RightControl`

### 配置与历史存储

文件：`src/main/config-store.ts`

存储策略：

- `config.json`：应用配置
- `history.json`：历史记录

新增配置项时同步更新：

- `StoreSchema`
- `DEFAULT_CONFIG`
- `getConfig()`
- renderer store
- 设置页 UI

## 共享定义

关键文件：

- `src/shared/types.ts`
- `src/shared/ipc-channels.ts`

重要类型：

- `PipelineStatus`
- `VoiceMode`
- `AppConfig`
- `OverlayHudPayload`
- `OverlayResultPayload`
- `PolishPreset`
- `ExcludedApp`

## 构建配置

### electron-vite

文件：`electron.vite.config.ts`

构建分为三段：

- `main`
- `preload`
- `renderer`

### electron-builder

文件：`electron-builder.yml`

当前支持：

- macOS：`dmg`、`zip`
- Windows：`nsis`

资源说明：

- macOS 打入 Swift helper
- Windows 打入 `WinKeyServer.exe`
- Windows 图标使用独立 `.ico` 资源

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
| Electron overlay backend | `src/main/electron-overlay-backend.ts` |
| 悬浮窗创建 | `src/main/overlay-window.ts` |
| 助手结果窗 | `src/main/assistant-result-window.ts` |
| 权限检查 | `src/main/permissions.ts` |
| 选中文本读取 | `src/main/selected-text.ts` |
| 托盘 | `src/main/tray.ts` |
| 原生快捷键 bridge | `src/native-keyboard-listener/index.ts` |
| macOS helper | `src/native-keyboard-listener/SwiftKeyboardListener/Sources/main.swift` |
| Windows helper | `src/native-keyboard-listener/WinKeyServer/` |
| 设置页 | `src/renderer/src/views/SettingsView.vue` |
| 设置 store | `src/renderer/src/stores/settings.ts` |
| Overlay 组件 | `src/renderer/overlay/Overlay.vue` |
| 设置 preload | `src/preload/index.ts` |
| Overlay preload | `src/preload/overlay.ts` |
| 共享类型 | `src/shared/types.ts` |
| IPC 常量 | `src/shared/ipc-channels.ts` |

## 修改代码时的注意点

- 快捷键系统必须通过统一 backend 抽象接入
- “快捷键录制”和“全局快捷键触发”是两个独立能力
- 不要把 Electron `globalShortcut` 当成唯一实现，它只是 fallback backend
- Overlay 展示必须通过统一 `OverlayBackend` / `OverlayManager` 接入
- 录音 HUD 与助手结果窗必须共用同一套 overlay backend 语义
- `assistant` 与 `transcription` 两套配置并存，改动时要检查两条链路
- 历史记录更新依赖 `IPC.HISTORY_UPDATED` 广播
- `hideDockIcon`、Dock 显隐等行为只对 macOS 有意义，Windows 侧不要复用旧的 mac 文案或语义

## 跨平台约束

- 配置层继续保存统一的快捷键字符串，不写死 macOS-only 语义到业务层
- 平台差异下沉到 backend capability，而不是 UI 或 Pipeline
- overlay 接口层必须平台无关
- “当前屏幕”统一定义为 cursor display
- 全屏置顶能力由 backend 自行实现
- Windows 与 macOS 应尽量对齐产品语义，但允许 backend 实现不同

## Native Overlay 设计守则

- 录音 HUD：轻量、不可交互、光标所在屏幕、全屏可见优先
- 助手结果窗：可交互、可复制、可关闭、可拖动、支持 Markdown 富文本
- 两类浮窗统一视觉语言，但职责分离
- native helper 构建产物继续忽略，不提交编译后的临时产物

## 替代关系

本仓库以后以 `AGENTS.md` 作为代理说明入口；`CLAUDE.md` 是旧文件，不再继续维护。
