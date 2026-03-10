# AGENTS.md

本文件为 Codex 在本仓库中的工作说明，内容基于当前代码实现整理，用于替代 `CLAUDE.md`。

## 项目概览

乐多汪汪（Leduo Wow）是一个 macOS 菜单栏语音输入工具，技术栈为 Electron + Vue 3 + Pinia。

核心能力：

- 全局快捷键唤起录音
- 调用 DashScope 风格实时 ASR 做语音转文字
- 可选地调用 OpenAI 兼容 LLM 做润色或回答
- 将结果自动输入到当前前台应用
- 用悬浮 Overlay 展示录音、处理中和结果状态

当前实现已经不是单一“语音转写”模式，而是双模式：

- `transcription`：语音识别 / 可选润色 / 自动输入
- `assistant`：语音识别 / 可选预润色 / 结合选中文本与截图让 LLM 直接回答 / 自动输入

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

启动流程中会先检查辅助功能权限；未授权时会提示打开系统设置，并直接退出，等待用户重新启动。

## 进程与窗口结构

### 主进程

入口：`src/main/index.ts`

负责：

- 初始化配置与历史存储
- 权限检查
- 创建设置窗口与 Overlay 窗口
- 初始化 `Pipeline`
- 初始化 `ShortcutManager`
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

### Overlay 窗口

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
7. 自动输入到前台 App
8. 写入历史

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

### ShortcutManager

文件：`src/main/shortcut.ts`

职责：

- 启动 Swift 原生键盘监听器
- 注册两个独立快捷键：
  - `transcriptionShortcut`
  - `assistantShortcut`
- 区分左右修饰键
- 录制快捷键期间暂停匹配，但保持键盘事件继续转发到设置页

默认快捷键：

- 转写：`RightCommand`
- 助手：`RightOption`

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
| 悬浮窗创建 | `src/main/overlay-window.ts` |
| 权限检查 | `src/main/permissions.ts` |
| 选中文本读取 | `src/main/selected-text.ts` |
| 托盘 | `src/main/tray.ts` |
| 原生键盘监听封装 | `src/native-keyboard-listener/index.ts` |
| Swift 键盘监听器源码 | `src/native-keyboard-listener/SwiftKeyboardListener/Sources/main.swift` |
| 设置页 | `src/renderer/src/views/SettingsView.vue` |
| 设置状态 | `src/renderer/src/stores/settings.ts` |
| Overlay 组件 | `src/renderer/overlay/Overlay.vue` |
| 设置窗口 preload | `src/preload/index.ts` |
| Overlay preload | `src/preload/overlay.ts` |
| 共享类型 | `src/shared/types.ts` |
| IPC 常量 | `src/shared/ipc-channels.ts` |

## 修改代码时的注意点

- 这是 macOS-only 应用，很多能力依赖系统权限与 AppleScript / CGEvent
- 快捷键系统不要退化成 Electron `globalShortcut`，当前实现依赖 Swift 监听器来区分左右修饰键
- Overlay 录音在 renderer 进程，ASR 编排在 main 进程，修改时不要混淆职责边界
- `assistant` 与 `transcription` 两套配置是并存的，改动时要检查两条链路
- 旧配置迁移逻辑已存在，新增配置项时要同步更新：
  - `StoreSchema`
  - `DEFAULT_CONFIG`
  - `getConfig()`
  - 设置页 store
  - 设置页 UI
- 历史记录更新依赖 `IPC.HISTORY_UPDATED` 广播
- Dock 图标显示是有节流和锁状态通知的，不要直接随意改 `app.dock.show/hide`

## 替代关系

本仓库以后以 `AGENTS.md` 作为代理说明入口；`CLAUDE.md` 是旧文件，不应再继续维护。
