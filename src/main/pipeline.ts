import { BrowserWindow, desktopCapturer, screen } from 'electron'
import { EventEmitter } from 'events'
import { writeFile, mkdir, readdir, unlink } from 'fs/promises'
import { join } from 'path'
import { PipelineStatus, VoiceMode } from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import { ASRClient } from './asr-client'
import { LLMPolisher } from './llm-polisher'
import { TextInputter } from './text-inputter'
import { getConfig, addHistory, ConfigStore } from './config-store'
import { getFrontmostApp } from './macos-apps'
import { positionOverlayAtCursor } from './overlay-window'
import { getSelectedText } from './selected-text'
import { showAssistantResultWindow } from './assistant-result-window'

export class Pipeline extends EventEmitter {
  private status: PipelineStatus = PipelineStatus.IDLE
  private currentMode: VoiceMode = 'transcription'
  private overlayWindow: BrowserWindow | null
  private assistantResultWindow: BrowserWindow | null
  private configStore: ConfigStore
  private asrClient: ASRClient | null = null
  private partialText: string = ''
  private screenshotBase64: string = ''
  private isProcessingComplete: boolean = false
  private screenshotActive: boolean = false
  private appCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor(overlayWindow: BrowserWindow | null, configStore: ConfigStore, assistantResultWindow: BrowserWindow | null) {
    super()
    this.overlayWindow = overlayWindow
    this.configStore = configStore
    this.assistantResultWindow = assistantResultWindow
  }

  getStatus(): PipelineStatus {
    return this.status
  }

  private setStatus(status: PipelineStatus): void {
    this.status = status
    this.emit('status', status)
    this.broadcastToWindows(IPC.PIPELINE_STATUS, status)
  }

  private broadcastToWindows(channel: string, ...args: unknown[]): void {
    const { BrowserWindow } = require('electron')
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, ...args)
      }
    }
  }

  async toggle(mode: VoiceMode = 'transcription'): Promise<void> {
    if (this.status === PipelineStatus.IDLE) {
      await this.startRecording(mode)
    } else if (this.status === PipelineStatus.RECORDING) {
      await this.stopRecording()
    } else {
      // If user presses hotkey during FINALIZING_ASR, POLISHING, or INPUTTING,
      // force cancel everything and go back to IDLE
      console.log(`[Pipeline] Toggle pressed during ${this.status}, force cancelling`)
      this.forceCancel()
    }
  }

  cancel(): void {
    if (this.status === PipelineStatus.IDLE) return
    console.log(`[Pipeline] Cancel requested during ${this.status}`)
    this.forceCancel()
  }

  handleAudioCaptureError(message: string): void {
    if (this.status !== PipelineStatus.RECORDING) return
    console.error('[Pipeline] Audio capture failed:', message)
    this.setStatus(PipelineStatus.ERROR)
    this.showOverlay('麦克风不可用，请检查设置', 'error')
    this.broadcastToWindows(IPC.PIPELINE_ERROR, `麦克风录音失败: ${message}`)
    setTimeout(() => this.reset(), 2500)
  }

  private async startRecording(mode: VoiceMode = 'transcription'): Promise<void> {
    const config = getConfig(this.configStore)
    this.currentMode = mode

    // 检查对应模式的启用状态
    if (mode === 'assistant' && !config.assistantEnabled) {
      this.showOverlay('语音助手已禁用', 'error')
      setTimeout(() => this.reset(), 2000)
      return
    }

    if (mode === 'transcription' && !config.transcriptionEnabled) {
      this.showOverlay('语音识别已禁用', 'error')
      setTimeout(() => this.reset(), 2000)
      return
    }

    if (!config.asrApiKey) {
      this.setStatus(PipelineStatus.ERROR)
      this.broadcastToWindows(IPC.PIPELINE_ERROR, '请先在设置中配置语音识别 API Key')
      this.showOverlay('请先配置 API Key', 'error')
      setTimeout(() => this.reset(), 2000)
      return
    }

    this.partialText = ''

    try {
      // Initialize ASR client
      this.asrClient = new ASRClient(config.asrApiKey, config.asrModel, config.asrBaseUrl)

      this.asrClient.on('partial', (text: string) => {
        // Always capture partial text for fallback, regardless of status
        this.partialText = text
        // Only update overlay during recording
        if (this.status === PipelineStatus.RECORDING) {
          this.broadcastToWindows(IPC.PIPELINE_PARTIAL_TEXT, text)
          this.showOverlay(text || '正在聆听...', 'recording')
        }
      })

      // Use .once — completed should only fire once per session.
      // If the server fires it unexpectedly (e.g. VAD auto-cut despite turn_detection:null),
      // we handle it gracefully instead of double-processing.
      this.asrClient.once('completed', (text: string) => {
        console.log(`[Pipeline] ASR completed event, status=${this.status}, text="${text.substring(0, 50)}"`)
        // Only process if we're still in RECORDING or FINALIZING_ASR state
        if (this.status === PipelineStatus.RECORDING || this.status === PipelineStatus.FINALIZING_ASR) {
          // Stop audio capture immediately if server auto-completed (user didn't press stop)
          if (this.status === PipelineStatus.RECORDING) {
            console.log('[Pipeline] Server auto-completed while recording, stopping audio capture')
            this.broadcastToWindows(IPC.AUDIO_STOP)
          }
          this.onASRComplete(text)
        } else {
          console.warn(`[Pipeline] Ignoring completed event in state ${this.status}`)
        }
      })

      this.asrClient.on('error', (err: Error) => {
        // Only treat as fatal error during recording phase
        // During FINALIZING_ASR, errors (like commit errors) are non-fatal
        // because the completed event will still arrive
        if (this.status === PipelineStatus.RECORDING) {
          console.error('ASR error:', err)
          this.setStatus(PipelineStatus.ERROR)
          this.showOverlay(`识别错误: ${err.message}`, 'error')
          setTimeout(() => this.reset(), 2000)
        } else {
          console.warn('[Pipeline] Non-fatal ASR error during', this.status, ':', err.message)
        }
      })

      // Start WebSocket connection FIRST — it needs network round-trip time.
      // Audio chunks will be buffered by appendAudio() and flushed when session is ready.
      const connectPromise = this.asrClient.start()

      // Show overlay and start audio capture while WebSocket is connecting
      this.setStatus(PipelineStatus.RECORDING)
      // 语音助手模式总是需要截图（因为总是要调用AI），语音识别模式根据polishEnabled决定
      const needScreenshot = mode === 'assistant' ? true : config.polishEnabled
      this.screenshotActive = !!(config.screenshotEnabled && needScreenshot)
      this.showOverlay('正在聆听...', 'recording')
      this.broadcastToWindows(IPC.AUDIO_START, config.audioThreshold ?? 0, config.selectedMicrophoneId ?? '', mode)

      // Start polling frontmost app to update screenshot status in real-time
      if (this.screenshotActive && config.screenshotExcludedApps.length > 0) {
        this.startAppCheckPolling(config.screenshotExcludedApps)
      }

      // Wait for WebSocket session to be configured
      await connectPromise
    } catch (err) {
      // Skip if error was already handled (e.g. by handleAudioCaptureError)
      if (this.status !== PipelineStatus.RECORDING) {
        console.warn('[Pipeline] startRecording error after state change, ignoring:', (err as Error).message)
        return
      }
      console.error('Failed to start recording:', err)
      this.setStatus(PipelineStatus.ERROR)
      this.showOverlay('启动失败', 'error')
      setTimeout(() => this.reset(), 2000)
    }
  }

  private async stopRecording(): Promise<void> {
    console.log('[Pipeline] stopRecording called')
    this.setStatus(PipelineStatus.FINALIZING_ASR)
    this.showOverlay('正在识别...', 'processing')

    // Capture screenshot before stopping audio (captures user's current screen context)
    const config = getConfig(this.configStore)
    this.stopAppCheckPolling()
    if (this.screenshotActive) {
      try {
        this.screenshotBase64 = await this.captureScreen()
        console.log(`[Pipeline] Screenshot captured, size=${this.screenshotBase64.length}`)
        // Save to disk if a save path is configured
        if (this.screenshotBase64 && config.screenshotSavePath) {
          this.saveScreenshot(config.screenshotSavePath, this.screenshotBase64, config.screenshotMaxCount)
        }
      } catch (err) {
        console.error('[Pipeline] Screenshot capture failed:', err)
        this.screenshotBase64 = ''
      }
    }

    // Stop audio capture in overlay FIRST — no more audio to ASR
    this.broadcastToWindows(IPC.AUDIO_STOP)

    try {
      if (this.asrClient) {
        await this.asrClient.finish()
      }
      // Check if onASRComplete was triggered by the completed event.
      // If finish() timed out or completed arrived in wrong state,
      // isProcessingComplete will still be false.
      if (!this.isProcessingComplete) {
        if (this.partialText) {
          console.log('[Pipeline] finish() resolved but no completion, using partial text')
          this.onASRComplete(this.partialText)
        } else {
          this.setStatus(PipelineStatus.ERROR)
          this.showOverlay('未检测到语音', 'error')
          setTimeout(() => this.reset(), 2000)
        }
      }
    } catch (err) {
      console.error('Failed to stop ASR:', err)
      if (this.partialText && !this.isProcessingComplete) {
        this.onASRComplete(this.partialText)
      } else if (!this.isProcessingComplete) {
        this.setStatus(PipelineStatus.ERROR)
        this.showOverlay('识别失败', 'error')
        setTimeout(() => this.reset(), 2000)
      }
    }
  }

  private async onASRComplete(text: string): Promise<void> {
    // Guard: prevent double execution
    if (this.isProcessingComplete) {
      console.warn('[Pipeline] onASRComplete called again, ignoring (already processing)')
      return
    }
    this.isProcessingComplete = true
    console.log(`[Pipeline] onASRComplete: "${text.substring(0, 50)}"`)

    if (!text.trim()) {
      this.showOverlay('未检测到语音', 'error')
      setTimeout(() => this.reset(), 1500)
      return
    }

    const config = getConfig(this.configStore)
    let outputText = text

    // 语音识别模式：使用润色提示词
    if (this.currentMode === 'transcription' && config.polishEnabled) {
      const apiKey = config.polishApiKey
      if (!apiKey) {
        console.warn('[Pipeline] Polish enabled but no polishApiKey configured, skipping')
      } else {
        this.setStatus(PipelineStatus.POLISHING)
        this.showOverlay('正在润色...', 'processing')

        try {
          const polisher = new LLMPolisher(apiKey, config.polishModel, config.polishBaseUrl)
          outputText = await polisher.polishStream(
            text,
            config.polishPrompt,
            this.screenshotBase64 || undefined,
            (partialText) => {
              if (this.status === PipelineStatus.POLISHING) {
                this.showOverlay(partialText, 'processing')
              }
            }
          )
        } catch (err) {
          console.error('Polish error:', err)
          outputText = text
        }
      }
    }

    // 语音助手模式：如果开启先润色，则先用润色提示词处理
    if (this.currentMode === 'assistant' && config.assistantPrePolish) {
      const apiKey = config.polishApiKey
      if (!apiKey) {
        console.warn('[Pipeline] Assistant pre-polish enabled but no polishApiKey configured, skipping')
      } else {
        this.setStatus(PipelineStatus.POLISHING)
        this.showOverlay('正在润色...', 'processing')

        try {
          const polisher = new LLMPolisher(apiKey, config.polishModel, config.polishBaseUrl)
          // 使用语音识别模式的润色提示词进行预处理
          outputText = await polisher.polishStream(
            text,
            config.polishPrompt,
            this.screenshotBase64 || undefined,
            (partialText) => {
              if (this.status === PipelineStatus.POLISHING) {
                this.showOverlay(partialText, 'processing')
              }
            }
          )
        } catch (err) {
          console.error('Pre-polish error:', err)
          outputText = text
        }
      }
    }

    // 语音助手模式：使用助手提示词处理（如果开启了先润色，则处理的是润色后的文本）
    if (this.currentMode === 'assistant') {
      const apiKey = config.polishApiKey
      if (!apiKey) {
        console.warn('[Pipeline] Assistant enabled but no polishApiKey configured, skipping')
      } else {
        this.setStatus(PipelineStatus.POLISHING)
        this.showOverlay('正在思考...', 'processing')

        try {
          // 获取选中的文本
          const selectedText = await getSelectedText()

          // 构建包含选中文本的 user prompt
          let userPrompt = outputText
          if (selectedText) {
            userPrompt = `我的语音指令是："${outputText}"\n\n选中的文本是：\n\`\`\`\n${selectedText}\n\`\`\``
          }

          const polisher = new LLMPolisher(apiKey, config.polishModel, config.polishBaseUrl)
          // 使用助手提示词处理（可能是原始文本或润色后的文本）
          outputText = await polisher.polishStream(
            userPrompt,
            config.assistantPrompt,
            this.screenshotBase64 || undefined,
            (partialText) => {
              if (this.status === PipelineStatus.POLISHING) {
                this.showOverlay(partialText, 'processing')
              }
            }
          )
        } catch (err) {
          console.error('Assistant error:', err)
          outputText = text
        }
      }
    }

    // Input text — hide overlay first to avoid interfering with frontmost app focus
    this.setStatus(PipelineStatus.INPUTTING)
    this.hideOverlay()

    // Wait for overlay to fully hide
    await this.delay(100)

    try {
      if (this.currentMode === 'assistant' && config.assistantOutputMode === 'popup') {
        showAssistantResultWindow(this.assistantResultWindow, outputText)
      } else {
        const inputter = new TextInputter()
        await inputter.input(outputText, config.inputMethod)
      }

      // Save to history
      addHistory(this.configStore, {
        id: Date.now().toString(),
        timestamp: Date.now(),
        originalText: text,
        polishedText: outputText,
        mode: this.currentMode
      })

      this.broadcastToWindows(IPC.PIPELINE_FINAL_TEXT, outputText, this.currentMode)
      this.reset()
    } catch (err) {
      console.error('Input error:', err)
      this.setStatus(PipelineStatus.ERROR)
      this.showOverlay('输入失败: ' + (err instanceof Error ? err.message : '未知错误'), 'error')
      setTimeout(() => this.reset(), 3000)
    }
  }

  appendAudioChunk(chunk: Buffer): void {
    if (this.status === PipelineStatus.RECORDING && this.asrClient) {
      this.asrClient.appendAudio(chunk)
    }
  }

  private reset(): void {
    console.log('[Pipeline] reset()')
    this.stopAppCheckPolling()
    // Abort ASR client if still active
    if (this.asrClient) {
      this.asrClient.abort()
      this.asrClient = null
    }
    this.partialText = ''
    this.screenshotBase64 = ''
    this.screenshotActive = false
    this.isProcessingComplete = false
    this.setStatus(PipelineStatus.IDLE)
    this.hideOverlay()
    // Ensure overlay audio capture is stopped
    this.broadcastToWindows(IPC.AUDIO_STOP)
  }

  private forceCancel(): void {
    console.log('[Pipeline] forceCancel()')
    this.stopAppCheckPolling()
    // Immediately abort everything and return to IDLE
    if (this.asrClient) {
      this.asrClient.abort()
      this.asrClient = null
    }
    this.partialText = ''
    this.screenshotActive = false
    this.isProcessingComplete = true  // Block any pending onASRComplete
    this.broadcastToWindows(IPC.AUDIO_STOP)
    this.setStatus(PipelineStatus.IDLE)
    this.hideOverlay()
    // Reset the processing flag after a short delay so next session works
    setTimeout(() => {
      this.isProcessingComplete = false
    }, 100)
  }

  private showOverlay(text: string, mode: string): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      // 定位到光标所在的屏幕
      positionOverlayAtCursor(this.overlayWindow)
      this.overlayWindow.showInactive()
      this.overlayWindow.webContents.send(IPC.OVERLAY_UPDATE, {
        text,
        mode,
        voiceMode: this.currentMode,
        screenshotActive: this.screenshotActive
      })
    }
  }

  private hideOverlay(): void {
    if (this.overlayWindow && !this.overlayWindow.isDestroyed()) {
      this.overlayWindow.hide()
      // Clear content so stale text doesn't flash when showing again
      this.overlayWindow.webContents.send(IPC.OVERLAY_UPDATE, { text: '', mode: '', screenshotActive: false })
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private startAppCheckPolling(excludedApps: { name: string; bundleId: string }[]): void {
    this.stopAppCheckPolling()
    // Check immediately on start
    this.checkFrontmostApp(excludedApps)
    // Then poll every 1 second
    this.appCheckTimer = setInterval(() => {
      this.checkFrontmostApp(excludedApps)
    }, 1000)
  }

  private stopAppCheckPolling(): void {
    if (this.appCheckTimer) {
      clearInterval(this.appCheckTimer)
      this.appCheckTimer = null
    }
  }

  private async checkFrontmostApp(excludedApps: { name: string; bundleId: string }[]): Promise<void> {
    try {
      const frontApp = await getFrontmostApp()
      const wasActive = this.screenshotActive
      if (frontApp && excludedApps.some(a => a.bundleId === frontApp.bundleId)) {
        this.screenshotActive = false
      } else {
        this.screenshotActive = true
      }
      // Push update to overlay if changed
      if (wasActive !== this.screenshotActive && this.overlayWindow && !this.overlayWindow.isDestroyed()) {
        this.overlayWindow.webContents.send(IPC.OVERLAY_UPDATE, {
          text: this.partialText || '正在聆听...',
          mode: this.status === PipelineStatus.RECORDING ? 'recording' : 'processing',
          voiceMode: this.currentMode,
          screenshotActive: this.screenshotActive
        })
      }
    } catch (err) {
      console.error('[Pipeline] App check failed:', err)
      // On error, keep screenshot active (don't skip)
    }
  }

  private async captureScreen(): Promise<string> {
    // Get the display where the cursor is located
    const cursorPoint = screen.getCursorScreenPoint()
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint)
    const { width, height } = targetDisplay.size
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    })
    // Find the source matching the target display
    const targetSource = sources.find(source => source.display_id === String(targetDisplay.id))
    if (targetSource) {
      return targetSource.thumbnail.toJPEG(80).toString('base64')
    }
    return ''
  }

  private async saveScreenshot(dirPath: string, base64Data: string, maxCount: number): Promise<void> {
    try {
      await mkdir(dirPath, { recursive: true })
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filePath = join(dirPath, `screenshot-${timestamp}.jpg`)
      await writeFile(filePath, Buffer.from(base64Data, 'base64'))
      console.log(`[Pipeline] Screenshot saved to ${filePath}`)

      // Clean up old screenshots if exceeding maxCount
      if (maxCount > 0) {
        this.cleanupOldScreenshots(dirPath, maxCount)
      }
    } catch (err) {
      console.error('[Pipeline] Failed to save screenshot:', err)
    }
  }

  private async cleanupOldScreenshots(dirPath: string, maxCount: number): Promise<void> {
    try {
      const files = await readdir(dirPath)
      const screenshots = files
        .filter(f => f.startsWith('screenshot-') && f.endsWith('.jpg'))
        .sort()
      if (screenshots.length > maxCount) {
        const toDelete = screenshots.slice(0, screenshots.length - maxCount)
        for (const file of toDelete) {
          await unlink(join(dirPath, file))
        }
        console.log(`[Pipeline] Cleaned up ${toDelete.length} old screenshots`)
      }
    } catch (err) {
      console.error('[Pipeline] Failed to cleanup screenshots:', err)
    }
  }
}
