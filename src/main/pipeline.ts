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
import { getSelectedText } from './selected-text'
import type { OverlayBackend } from './overlay-backend'

export class Pipeline extends EventEmitter {
  private status: PipelineStatus = PipelineStatus.IDLE
  private currentMode: VoiceMode = 'transcription'
  private overlay: OverlayBackend
  private configStore: ConfigStore
  private asrClient: ASRClient | null = null
  private partialText: string = ''
  private screenshotBase64: string = ''
  private isProcessingComplete: boolean = false
  private screenshotActive: boolean = false
  private appCheckTimer: ReturnType<typeof setInterval> | null = null

  constructor(overlay: OverlayBackend, configStore: ConfigStore) {
    super()
    this.overlay = overlay
    this.configStore = configStore
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
    this.showHud('麦克风不可用，请检查设置', 'error')
    this.broadcastToWindows(IPC.PIPELINE_ERROR, `麦克风录音失败: ${message}`)
    setTimeout(() => this.reset(), 2500)
  }

  private async startRecording(mode: VoiceMode = 'transcription'): Promise<void> {
    const config = getConfig(this.configStore)
    this.currentMode = mode
    this.overlay.hideResult()

    if (mode === 'assistant' && !config.assistantEnabled) {
      this.showHud('语音助手已禁用', 'error')
      setTimeout(() => this.reset(), 2000)
      return
    }

    if (mode === 'transcription' && !config.transcriptionEnabled) {
      this.showHud('语音识别已禁用', 'error')
      setTimeout(() => this.reset(), 2000)
      return
    }

    if (!config.asrApiKey) {
      this.setStatus(PipelineStatus.ERROR)
      this.broadcastToWindows(IPC.PIPELINE_ERROR, '请先在设置中配置语音识别 API Key')
      this.showHud('请先配置 API Key', 'error')
      setTimeout(() => this.reset(), 2000)
      return
    }

    this.partialText = ''

    try {
      this.asrClient = new ASRClient(config.asrApiKey, config.asrModel, config.asrBaseUrl)

      this.asrClient.on('partial', (text: string) => {
        this.partialText = text
        if (this.status === PipelineStatus.RECORDING) {
          this.broadcastToWindows(IPC.PIPELINE_PARTIAL_TEXT, text)
          this.showHud(text || '正在聆听...', 'recording')
        }
      })

      this.asrClient.once('completed', (text: string) => {
        console.log(`[Pipeline] ASR completed event, status=${this.status}, text="${text.substring(0, 50)}"`)
        if (this.status === PipelineStatus.RECORDING || this.status === PipelineStatus.FINALIZING_ASR) {
          if (this.status === PipelineStatus.RECORDING) {
            console.log('[Pipeline] Server auto-completed while recording, stopping audio capture')
            this.broadcastToWindows(IPC.AUDIO_STOP)
          }
          void this.onASRComplete(text)
        } else {
          console.warn(`[Pipeline] Ignoring completed event in state ${this.status}`)
        }
      })

      this.asrClient.on('error', (err: Error) => {
        if (this.status === PipelineStatus.RECORDING) {
          console.error('ASR error:', err)
          this.setStatus(PipelineStatus.ERROR)
          this.showHud(`识别错误: ${err.message}`, 'error')
          setTimeout(() => this.reset(), 2000)
        } else {
          console.warn('[Pipeline] Non-fatal ASR error during', this.status, ':', err.message)
        }
      })

      const connectPromise = this.asrClient.start()

      this.setStatus(PipelineStatus.RECORDING)
      const needScreenshot = mode === 'assistant' ? true : config.polishEnabled
      this.screenshotActive = !!(config.screenshotEnabled && needScreenshot)
      this.showHud('正在聆听...', 'recording')
      this.broadcastToWindows(IPC.AUDIO_START, config.audioThreshold ?? 0, config.selectedMicrophoneId ?? '', mode)

      if (this.screenshotActive && config.screenshotExcludedApps.length > 0) {
        this.startAppCheckPolling(config.screenshotExcludedApps)
      }

      await connectPromise
    } catch (err) {
      if (this.status !== PipelineStatus.RECORDING) {
        console.warn('[Pipeline] startRecording error after state change, ignoring:', (err as Error).message)
        return
      }
      console.error('Failed to start recording:', err)
      this.setStatus(PipelineStatus.ERROR)
      this.showHud('启动失败', 'error')
      setTimeout(() => this.reset(), 2000)
    }
  }

  private async stopRecording(): Promise<void> {
    console.log('[Pipeline] stopRecording called')
    this.setStatus(PipelineStatus.FINALIZING_ASR)
    this.showHud('正在识别...', 'processing')

    const config = getConfig(this.configStore)
    this.stopAppCheckPolling()
    if (this.screenshotActive) {
      try {
        this.screenshotBase64 = await this.captureScreen()
        console.log(`[Pipeline] Screenshot captured, size=${this.screenshotBase64.length}`)
        if (this.screenshotBase64 && config.screenshotSavePath) {
          this.saveScreenshot(config.screenshotSavePath, this.screenshotBase64, config.screenshotMaxCount)
        }
      } catch (err) {
        console.error('[Pipeline] Screenshot capture failed:', err)
        this.screenshotBase64 = ''
      }
    }

    this.broadcastToWindows(IPC.AUDIO_STOP)

    try {
      if (this.asrClient) {
        await this.asrClient.finish()
      }
      if (!this.isProcessingComplete) {
        if (this.partialText) {
          console.log('[Pipeline] finish() resolved but no completion, using partial text')
          await this.onASRComplete(this.partialText)
        } else {
          this.setStatus(PipelineStatus.ERROR)
          this.showHud('未检测到语音', 'error')
          setTimeout(() => this.reset(), 2000)
        }
      }
    } catch (err) {
      console.error('Failed to stop ASR:', err)
      if (this.partialText && !this.isProcessingComplete) {
        await this.onASRComplete(this.partialText)
      } else if (!this.isProcessingComplete) {
        this.setStatus(PipelineStatus.ERROR)
        this.showHud('识别失败', 'error')
        setTimeout(() => this.reset(), 2000)
      }
    }
  }

  private async onASRComplete(text: string): Promise<void> {
    if (this.isProcessingComplete) {
      console.warn('[Pipeline] onASRComplete called again, ignoring (already processing)')
      return
    }
    this.isProcessingComplete = true
    console.log(`[Pipeline] onASRComplete: "${text.substring(0, 50)}"`)

    if (!text.trim()) {
      this.showHud('未检测到语音', 'error')
      setTimeout(() => this.reset(), 1500)
      return
    }

    const config = getConfig(this.configStore)
    let outputText = text

    if (this.currentMode === 'transcription' && config.polishEnabled) {
      const apiKey = config.polishApiKey
      if (!apiKey) {
        console.warn('[Pipeline] Polish enabled but no polishApiKey configured, skipping')
      } else {
        this.setStatus(PipelineStatus.POLISHING)
        this.showHud('正在润色...', 'processing')

        try {
          const polisher = new LLMPolisher(apiKey, config.polishModel, config.polishBaseUrl)
          outputText = await polisher.polishStream(
            text,
            config.polishPrompt,
            this.screenshotBase64 || undefined,
            () => {
              if (this.status === PipelineStatus.POLISHING) {
                this.showHud('正在润色...', 'processing')
              }
            }
          )
        } catch (err) {
          console.error('Polish error:', err)
          outputText = text
        }
      }
    }

    if (this.currentMode === 'assistant' && config.assistantPrePolish) {
      const apiKey = config.polishApiKey
      if (!apiKey) {
        console.warn('[Pipeline] Assistant pre-polish enabled but no polishApiKey configured, skipping')
      } else {
        this.setStatus(PipelineStatus.POLISHING)
        this.showHud('正在润色...', 'processing')

        try {
          const polisher = new LLMPolisher(apiKey, config.polishModel, config.polishBaseUrl)
          outputText = await polisher.polishStream(
            text,
            config.polishPrompt,
            this.screenshotBase64 || undefined,
            () => {
              if (this.status === PipelineStatus.POLISHING) {
                this.showHud('正在润色...', 'processing')
              }
            }
          )
        } catch (err) {
          console.error('Pre-polish error:', err)
          outputText = text
        }
      }
    }

    if (this.currentMode === 'assistant') {
      const apiKey = config.polishApiKey
      if (!apiKey) {
        console.warn('[Pipeline] Assistant enabled but no polishApiKey configured, skipping')
      } else {
        this.setStatus(PipelineStatus.POLISHING)
        this.showHud('正在思考...', 'processing')

        try {
          const selectedText = await getSelectedText()
          let userPrompt = outputText
          if (selectedText) {
            userPrompt = `我的语音指令是："${outputText}"\n\n选中的文本是：\n\`\`\`\n${selectedText}\n\`\`\``
          }

          const polisher = new LLMPolisher(apiKey, config.polishModel, config.polishBaseUrl)
          outputText = await polisher.polishStream(
            userPrompt,
            config.assistantPrompt,
            this.screenshotBase64 || undefined,
            () => {
              if (this.status === PipelineStatus.POLISHING) {
                this.showHud('正在思考...', 'processing')
              }
            }
          )
        } catch (err) {
          console.error('Assistant error:', err)
          outputText = text
        }
      }
    }

    this.setStatus(PipelineStatus.INPUTTING)
    this.overlay.hideHud()
    await this.delay(100)

    try {
      if (this.currentMode === 'assistant' && config.assistantOutputMode === 'window') {
        this.overlay.showResult({
          text: outputText,
          format: 'markdown'
        })
      } else {
        const inputter = new TextInputter()
        await inputter.input(outputText, config.inputMethod)
      }

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
      console.error('Output error:', err)
      this.setStatus(PipelineStatus.ERROR)
      this.showHud('输出失败: ' + (err instanceof Error ? err.message : '未知错误'), 'error')
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
    if (this.asrClient) {
      this.asrClient.abort()
      this.asrClient = null
    }
    this.partialText = ''
    this.screenshotBase64 = ''
    this.screenshotActive = false
    this.isProcessingComplete = false
    this.setStatus(PipelineStatus.IDLE)
    this.overlay.hideHud()
    this.broadcastToWindows(IPC.AUDIO_STOP)
  }

  private forceCancel(): void {
    console.log('[Pipeline] forceCancel()')
    this.stopAppCheckPolling()
    if (this.asrClient) {
      this.asrClient.abort()
      this.asrClient = null
    }
    this.partialText = ''
    this.screenshotActive = false
    this.isProcessingComplete = true
    this.broadcastToWindows(IPC.AUDIO_STOP)
    this.setStatus(PipelineStatus.IDLE)
    this.overlay.hideHud()
    setTimeout(() => {
      this.isProcessingComplete = false
    }, 100)
  }

  private showHud(text: string, mode: 'recording' | 'processing' | 'success' | 'error'): void {
    this.overlay.updateHud({
      text,
      mode,
      voiceMode: this.currentMode,
      screenshotActive: this.screenshotActive
    })
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  private startAppCheckPolling(excludedApps: { name: string; bundleId: string }[]): void {
    this.stopAppCheckPolling()
    void this.checkFrontmostApp(excludedApps)
    this.appCheckTimer = setInterval(() => {
      void this.checkFrontmostApp(excludedApps)
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

      if (wasActive !== this.screenshotActive && this.status !== PipelineStatus.IDLE) {
        this.overlay.updateHud({
          text: this.partialText || '正在聆听...',
          mode: this.status === PipelineStatus.RECORDING ? 'recording' : 'processing',
          voiceMode: this.currentMode,
          screenshotActive: this.screenshotActive
        })
      }
    } catch (err) {
      console.error('[Pipeline] App check failed:', err)
    }
  }

  private async captureScreen(): Promise<string> {
    const cursorPoint = screen.getCursorScreenPoint()
    const targetDisplay = screen.getDisplayNearestPoint(cursorPoint)
    const { width, height } = targetDisplay.size
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    })
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

      if (maxCount > 0) {
        void this.cleanupOldScreenshots(dirPath, maxCount)
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
