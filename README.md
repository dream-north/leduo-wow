# 乐多汪汪 (Leduo Wow)

macOS 语音输入应用，基于 Qwen ASR 和 LLM 构建。

## 功能特性

- **语音识别** - 按住快捷键说话，松开后自动识别并输入文字
- **语音助手** - 语音提问，AI 智能回答
- **文本润色** - 可选 LLM 润色功能，优化识别结果
- **双模式支持** - 支持左右修饰键区分（如 RightCommand / RightOption）
- **全局快捷键** - 系统级快捷键，在任何应用中都可触发

## 系统要求

- macOS 12.0 或更高版本
- 需要授予辅助功能权限（用于全局快捷键监听）
- 需要授予麦克风权限

## 安装

```bash
# 克隆仓库
git clone https://github.com/yourusername/leduo-wow.git
cd leduo-wow

# 安装依赖
npm install

# 开发模式
npm run dev

# 构建
npm run build
npm run pack
```

## 配置

### API 配置

应用使用阿里云 DashScope API：

1. 前往 [DashScope 控制台](https://dashscope.console.aliyun.com/) 获取 API Key
2. 在设置页面填入 API Key

### 快捷键配置

默认快捷键：
- **语音识别**: `RightCommand` (右侧 Command 键)
- **语音助手**: `RightOption` (右侧 Option 键)

支持自定义快捷键，包括：
- 单修饰键（如 RightCommand、LeftOption）
- 组合键（如 Command+Space、Option+A）

## 项目结构

```
src/
├── main/                    # Electron 主进程
│   ├── pipeline.ts          # 核心处理流程
│   ├── asr-client.ts        # ASR WebSocket 客户端
│   ├── llm-polisher.ts      # LLM 文本润色
│   ├── text-inputter.ts     # 文本输入
│   ├── shortcut.ts          # 快捷键服务
│   └── ...
├── native-keyboard-listener/ # Swift 原生键盘监听
│   └── SwiftKeyboardListener/
├── renderer/                # 渲染进程 (Vue 3)
│   └── src/
│       ├── views/           # 页面组件
│       ├── stores/          # Pinia 状态管理
│       └── ...
├── shared/                  # 共享类型定义
└── preload/                 # 预加载脚本
```

## 技术栈

- **Electron** - 跨平台桌面应用框架
- **Vue 3** - 前端框架
- **Pinia** - 状态管理
- **TypeScript** - 类型安全
- **Swift** - 原生键盘监听（CGEventTap）
- **WebSocket** - 实时语音识别

## 开发

```bash
# 类型检查
npm run typecheck

# 代码检查
npm run lint

# 运行测试
npm test
```

## License

MIT