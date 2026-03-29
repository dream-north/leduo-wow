<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

declare global {
  interface Window {
    overlayAPI: {
      onUpdate: (callback: (data: { text: string; mode: string; voiceMode?: 'transcription' | 'assistant' | 'screen_doc'; screenshotActive?: boolean }) => void) => () => void
      onAudioStart: (callback: (threshold: number, microphoneId: string, voiceMode?: 'transcription' | 'assistant' | 'screen_doc') => void) => () => void
      onAudioStop: (callback: () => void) => () => void
      sendAudioChunk: (chunk: ArrayBuffer) => void
      sendAudioError: (message: string) => void
      onThresholdUpdate: (callback: (threshold: number) => void) => () => void
    }
  }
}

const text = ref('')
const mode = ref('')
const voiceMode = ref<'transcription' | 'assistant' | 'screen_doc'>('transcription')
const screenshotActive = ref(false)

let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let isCapturing = false
let volumeThreshold = 10

const modeLabel = computed(() => {
  if (voiceMode.value === 'assistant') return '语音助手'
  if (voiceMode.value === 'screen_doc') return '录屏整理'
  return '语音识别'
})
const statusTitle = computed(() => {
  if (mode.value === 'recording') {
    return '正在聆听'
  }
  if (mode.value === 'processing') {
    if (text.value.includes('工具')) return '正在调用工具'
    if (text.value.includes('思考')) return '正在思考'
    if (voiceMode.value === 'assistant') return '正在生成回答'
    if (voiceMode.value === 'screen_doc') return '正在整理文档'
    return '正在处理中'
  }
  if (mode.value === 'success') {
    return '已完成'
  }
  if (mode.value === 'error') {
    return '出现问题'
  }
  return '等待开始'
})
const statusText = computed(() => {
  if (text.value.trim()) {
    return text.value
  }
  if (mode.value === 'recording') {
    if (voiceMode.value === 'screen_doc') {
      return '录屏和语音说明都会被记录，停止后会自动整理成文档。'
    }
    return voiceMode.value === 'assistant'
      ? '继续说话，松开快捷键后会直接生成回答。'
      : '继续说话，松开快捷键后会开始识别。'
  }
  if (mode.value === 'processing') {
    if (voiceMode.value === 'screen_doc') {
      return '正在上传录屏并分析关键操作，稍后会生成带截图的步骤文档。'
    }
    return voiceMode.value === 'assistant'
      ? '模型正在整理内容，结果会很快出现。'
      : '正在收尾并整理转写结果。'
  }
  if (mode.value === 'success') {
    return '这次语音任务已经顺利完成。'
  }
  if (mode.value === 'error') {
    return '本次任务没有完成，请检查权限、网络或模型配置。'
  }
  return '按下快捷键后，这里会显示当前状态。'
})
const phaseBadge = computed(() => {
  if (mode.value === 'recording') return '录音中'
  if (mode.value === 'processing') return '处理中'
  if (mode.value === 'success') return '完成'
  if (mode.value === 'error') return '错误'
  return '待命'
})
const showCancelHint = computed(() => mode.value === 'recording')

function calcRMS(buffer: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i]
  }
  return Math.sqrt(sum / buffer.length) * 100
}

async function startAudioCapture(threshold: number, microphoneId: string): Promise<void> {
  if (isCapturing) {
    stopAudioCapture()
  }
  isCapturing = true
  volumeThreshold = threshold

  try {
    const audioConstraints: MediaTrackConstraints = {
      sampleRate: 16000,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true
    }
    if (microphoneId) {
      audioConstraints.deviceId = { exact: microphoneId }
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })

    audioContext = new AudioContext({ sampleRate: 16000 })
    const source = audioContext.createMediaStreamSource(mediaStream)
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1)

    scriptProcessor.onaudioprocess = (event) => {
      if (!isCapturing) return
      const inputData = event.inputBuffer.getChannelData(0)
      const rms = calcRMS(inputData)
      if (rms < volumeThreshold) return

      const pcmData = new Int16Array(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        const sample = Math.max(-1, Math.min(1, inputData[i]))
        pcmData[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
      }
      window.overlayAPI.sendAudioChunk(pcmData.buffer)
    }

    source.connect(scriptProcessor)
    scriptProcessor.connect(audioContext.destination)
  } catch (error) {
    isCapturing = false
    window.overlayAPI?.sendAudioError(error instanceof Error ? error.message : String(error))
  }
}

function stopAudioCapture(): void {
  isCapturing = false
  if (scriptProcessor) {
    scriptProcessor.disconnect()
    scriptProcessor = null
  }
  if (audioContext) {
    void audioContext.close()
    audioContext = null
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }
}

let cleanupUpdate: (() => void) | null = null
let cleanupAudioStart: (() => void) | null = null
let cleanupAudioStop: (() => void) | null = null
let cleanupThreshold: (() => void) | null = null

onMounted(() => {
  if (!window.overlayAPI) {
    mode.value = 'recording'
    voiceMode.value = 'assistant'
    screenshotActive.value = true
    text.value = '这是 HUD 的示例态，用来检查 Windows 下的视觉效果。'
    return
  }

  cleanupUpdate = window.overlayAPI.onUpdate((data) => {
    text.value = data.text
    mode.value = data.mode
    if (data.voiceMode) {
      voiceMode.value = data.voiceMode
    }
    if (data.screenshotActive !== undefined) {
      screenshotActive.value = data.screenshotActive
    }
  })

  cleanupAudioStart = window.overlayAPI.onAudioStart((threshold, microphoneId, nextMode) => {
    if (nextMode) {
      voiceMode.value = nextMode
    }
    void startAudioCapture(threshold, microphoneId)
  })

  cleanupAudioStop = window.overlayAPI.onAudioStop(() => {
    stopAudioCapture()
  })

  cleanupThreshold = window.overlayAPI.onThresholdUpdate((threshold) => {
    volumeThreshold = threshold
  })
})

onUnmounted(() => {
  cleanupUpdate?.()
  cleanupAudioStart?.()
  cleanupAudioStop?.()
  cleanupThreshold?.()
  stopAudioCapture()
})
</script>

<template>
  <div :class="['overlay-container', mode || 'idle', voiceMode]">
    <div class="overlay-panel">
      <div class="panel-topline">
        <span class="mode-chip">{{ modeLabel }}</span>
        <span class="phase-chip">{{ phaseBadge }}</span>
        <span v-if="screenshotActive" class="context-chip">截图上下文</span>
        <span v-if="showCancelHint" class="cancel-pill" aria-label="按 Esc 取消">
          <span class="cancel-pill-label">取消</span>
          <span class="cancel-pill-key">Esc</span>
        </span>
      </div>

      <div class="panel-main">
        <div class="indicator" aria-hidden="true">
          <div v-if="mode === 'recording'" class="indicator-bars">
            <span></span>
            <span></span>
            <span></span>
          </div>
          <div v-else-if="mode === 'processing'" class="indicator-spinner"></div>
          <div v-else-if="mode === 'success'" class="indicator-symbol success-symbol"></div>
          <div v-else-if="mode === 'error'" class="indicator-symbol error-symbol"></div>
          <div v-else class="indicator-idle"></div>
        </div>

        <div class="copy-block">
          <p class="status-title">{{ statusTitle }}</p>
          <p class="status-text">{{ statusText }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<style>
html,
body,
#app {
  width: 100%;
  height: 100%;
  margin: 0;
  background: transparent;
  overflow: hidden;
}

body {
  font-family: 'Aptos', 'Segoe UI Variable Text', 'Segoe UI', sans-serif;
}

* {
  box-sizing: border-box;
}

.overlay-container {
  --panel-top: rgba(52, 60, 74, 0.9);
  --panel-bottom: rgba(35, 43, 58, 0.84);
  --panel-glow: rgba(130, 144, 164, 0.18);
  --mode-chip-bg: rgba(255, 255, 255, 0.05);
  --mode-chip-border: rgba(255, 255, 255, 0.12);
  --accent: #f97316;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  padding: 1px;
  background: transparent;
}

.overlay-container.screen_doc {
  --accent: #0f766e;
}

.overlay-container.transcription {
  --panel-top: rgba(52, 60, 74, 0.9);
  --panel-bottom: rgba(35, 43, 58, 0.84);
  --panel-glow: rgba(130, 144, 164, 0.18);
  --mode-chip-bg: rgba(249, 115, 22, 0.08);
  --mode-chip-border: rgba(249, 115, 22, 0.18);
}

.overlay-container.assistant {
  --panel-top: rgba(24, 53, 76, 0.9);
  --panel-bottom: rgba(16, 37, 57, 0.84);
  --panel-glow: rgba(74, 168, 236, 0.2);
  --mode-chip-bg: rgba(14, 165, 233, 0.12);
  --mode-chip-border: rgba(56, 189, 248, 0.22);
  --accent: #0ea5e9;
}

.overlay-container.success {
  --accent: #10b981;
}

.overlay-container.error {
  --accent: #ef4444;
}

.overlay-panel {
  position: relative;
  width: 100%;
  max-width: none;
  padding: 16px 18px;
  border-radius: 22px;
  background:
    radial-gradient(circle at top right, var(--panel-glow), transparent 32%),
    linear-gradient(180deg, var(--panel-top), var(--panel-bottom));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  overflow: hidden;
}

.overlay-panel::after {
  display: none;
}

.panel-topline {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.mode-chip,
.phase-chip,
.context-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--mode-chip-border);
  color: rgba(241, 245, 249, 0.95);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  background: var(--mode-chip-bg);
}

.phase-chip {
  border-color: rgba(255, 255, 255, 0.18);
  color: #fff;
  background: rgba(249, 115, 22, 0.22);
}

.overlay-container.assistant .phase-chip {
  background: rgba(14, 165, 233, 0.22);
}

.overlay-container.success .phase-chip {
  background: rgba(16, 185, 129, 0.22);
}

.overlay-container.error .phase-chip {
  background: rgba(239, 68, 68, 0.22);
}

.context-chip {
  color: #dbeafe;
  background: rgba(56, 189, 248, 0.18);
}

.cancel-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  min-height: 26px;
  padding: 0 6px 0 10px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.06);
  color: rgba(226, 232, 240, 0.9);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.cancel-pill-label {
  line-height: 1;
}

.cancel-pill-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 20px;
  padding: 0 8px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.12);
  color: #f8fafc;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: none;
}

.panel-main {
  display: flex;
  align-items: center;
  gap: 16px;
}

.indicator {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 18px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.04));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.12);
}

.indicator::before {
  content: '';
  position: absolute;
  inset: 8px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--accent) 42%, rgba(255, 255, 255, 0.12));
  opacity: 0.7;
}

.indicator-bars {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 24px;
  position: relative;
  z-index: 1;
}

.indicator-bars span {
  width: 6px;
  border-radius: 999px;
  background: linear-gradient(180deg, color-mix(in srgb, var(--accent) 72%, white), var(--accent));
  animation: bounce 1s ease-in-out infinite;
}

.indicator-bars span:nth-child(1) {
  height: 12px;
  animation-delay: 0s;
}

.indicator-bars span:nth-child(2) {
  height: 22px;
  animation-delay: 0.12s;
}

.indicator-bars span:nth-child(3) {
  height: 16px;
  animation-delay: 0.24s;
}

.indicator-spinner {
  width: 24px;
  height: 24px;
  border-radius: 999px;
  border: 2px solid rgba(255, 255, 255, 0.18);
  border-top-color: var(--accent);
  border-right-color: color-mix(in srgb, var(--accent) 60%, white);
  animation: spin 0.85s linear infinite;
}

.indicator-symbol,
.indicator-idle {
  width: 24px;
  height: 24px;
  position: relative;
}

.success-symbol::before,
.success-symbol::after,
.error-symbol::before,
.error-symbol::after {
  content: '';
  position: absolute;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 76%, white);
}

.success-symbol::before {
  left: 6px;
  top: 12px;
  width: 5px;
  height: 12px;
  transform: rotate(38deg);
}

.success-symbol::after {
  left: 12px;
  top: 8px;
  width: 5px;
  height: 18px;
  transform: rotate(-42deg);
}

.error-symbol::before,
.error-symbol::after {
  left: 11px;
  top: 2px;
  width: 4px;
  height: 20px;
}

.error-symbol::before {
  transform: rotate(45deg);
}

.error-symbol::after {
  transform: rotate(-45deg);
}

.indicator-idle {
  border-radius: 999px;
  background: radial-gradient(circle, color-mix(in srgb, var(--accent) 75%, white), color-mix(in srgb, var(--accent) 35%, transparent));
  box-shadow: 0 0 0 8px rgba(255, 255, 255, 0.06);
}

.copy-block {
  min-width: 0;
}

.status-title,
.status-text {
  margin: 0;
}

.status-title {
  color: #f8fafc;
  font-family: 'Segoe UI Variable Display', 'Aptos Display', 'Aptos', sans-serif;
  font-size: 20px;
  font-weight: 650;
  letter-spacing: -0.03em;
}

.status-text {
  margin-top: 6px;
  color: rgba(226, 232, 240, 0.86);
  font-size: 13px;
  line-height: 1.6;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

@keyframes bounce {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.8;
  }
  50% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
