# 乐多汪汪 (Leduo Wow)

多平台语音输入与语音助手应用，基于 Electron + Vue 3 + Pinia，当前支持 macOS 和 Windows。

## 功能特性

- **语音识别**：按下快捷键开始录音，再按一次结束，自动识别并输出文字
- **语音助手**：语音提问，结合选中文本和截图上下文让 AI 直接回答
- **文本润色**：可选 LLM 润色能力，优化识别结果
- **双模式支持**：`transcription` 与 `assistant` 两套独立配置并存
- **全局快捷键**：支持全局唤起，Windows 已支持 `RightAlt` / `RightCtrl`
- **悬浮窗反馈**：录音 HUD、处理中状态、助手结果窗统一反馈
- **自动输入**：支持回填到当前前台应用，或在独立结果窗展示

## 支持平台

- **macOS**：优先使用原生快捷键与原生 overlay helper
- **Windows**：使用原生快捷键监听 + Electron 结果窗 / HUD

## 运行要求

### macOS

- macOS 13.0 或更高版本
- 麦克风权限
- 辅助功能权限（全局快捷键、文本输入模拟）
- 屏幕录制权限（截图上下文可选）

### Windows

- Windows 10 / 11 x64
- 麦克风权限
- 可用的全局快捷键监听能力
- 打包环境需要 Visual Studio Build Tools 2022 + Python setuptools

## 开发命令

```bash
npm run dev
npm run build
npm run build:native
npm run typecheck
npm run lint
npm run test
```

## 打包命令

### macOS

```bash
./build.sh
```

等价于：

```bash
rm -rf dist/mac-arm64
npm run build:native && npm run build && npm run pack
```

### Windows

双击：

- `build-win.cmd`

或命令行：

```powershell
.\build-win.ps1
```

等价于：

```bash
npm run build:native
npm run build
npm run pack:win
```

## 目录说明

- `src/main`：Electron 主进程、Pipeline、快捷键、权限、输入回填
- `src/renderer/src`：设置页、结果窗 renderer、Pinia store
- `src/renderer/overlay`：录音 HUD / overlay renderer
- `src/preload`：设置页、overlay、结果窗 preload bridge
- `src/shared`：共享类型、默认配置、IPC 常量
- `src/native-keyboard-listener`：原生快捷键监听与原生 overlay bridge
- `build`：打包脚本、图标资源、afterPack 钩子

## 当前状态

- macOS 与 Windows 都已支持基础可用版本
- macOS 仍以 native overlay 为长期主路径
- Windows 当前优先使用 Electron overlay / result window，但快捷键监听已具备原生能力
- Windows 安装包已支持 NSIS 输出
