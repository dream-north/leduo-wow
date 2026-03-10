<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

declare global {
  interface Window {
    overlayAPI: {
      onUpdate: (callback: (data: { text: string; mode: string; voiceMode?: 'transcription' | 'assistant'; screenshotActive?: boolean }) => void) => () => void
      onAudioStart: (callback: (threshold: number, microphoneId: string, voiceMode?: 'transcription' | 'assistant') => void) => () => void
      onAudioStop: (callback: () => void) => () => void
      sendAudioChunk: (chunk: ArrayBuffer) => void
      sendAudioError: (message: string) => void
      onThresholdUpdate: (callback: (threshold: number) => void) => () => void
    }
  }
}

const text = ref('')
const mode = ref('') // recording, processing, success, error
const voiceMode = ref<'transcription' | 'assistant'>('transcription')
const screenshotActive = ref(false)

// Audio recording
let mediaStream: MediaStream | null = null
let audioContext: AudioContext | null = null
let scriptProcessor: ScriptProcessorNode | null = null
let isCapturing = false
let volumeThreshold = 10 // RMS threshold 0-100, default 10

// Calculate RMS volume of a Float32 audio buffer, returns 0-100
function calcRMS(buffer: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buffer.length; i++) {
    sum += buffer[i] * buffer[i]
  }
  return Math.sqrt(sum / buffer.length) * 100
}

async function startAudioCapture(threshold: number, microphoneId: string): Promise<void> {
  // Prevent duplicate capture — stop existing one first
  if (isCapturing) {
    console.log('[Overlay] Already capturing, stopping previous before restart')
    stopAudioCapture()
  }
  isCapturing = true
  volumeThreshold = threshold
  console.log(`[Overlay] startAudioCapture, volumeThreshold=${volumeThreshold}, mic=${microphoneId || 'default'}`)

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

    // Use ScriptProcessorNode for compatibility (AudioWorklet would be better but more complex)
    scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1)

    scriptProcessor.onaudioprocess = (event) => {
      if (!isCapturing) return  // Skip if capture was stopped
      const inputData = event.inputBuffer.getChannelData(0)

      // Volume gate: skip frames below threshold to filter background noise
      const rms = calcRMS(inputData)
      if (rms < volumeThreshold) return

      // Convert Float32 to Int16 PCM
      const pcmData = new Int16Array(inputData.length)
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]))
        pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff
      }
      window.overlayAPI.sendAudioChunk(pcmData.buffer)
    }

    source.connect(scriptProcessor)
    scriptProcessor.connect(audioContext.destination)
  } catch (err) {
    console.error('Failed to start audio capture:', err)
    isCapturing = false
    window.overlayAPI.sendAudioError(err instanceof Error ? err.message : String(err))
  }
}

function stopAudioCapture(): void {
  console.log('[Overlay] stopAudioCapture called, isCapturing:', isCapturing)
  isCapturing = false
  if (scriptProcessor) {
    scriptProcessor.disconnect()
    scriptProcessor = null
  }
  if (audioContext) {
    audioContext.close()
    audioContext = null
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }
}

// Cleanup functions for IPC listeners
let cleanupUpdate: (() => void) | null = null
let cleanupAudioStart: (() => void) | null = null
let cleanupAudioStop: (() => void) | null = null
let cleanupThreshold: (() => void) | null = null

onMounted(() => {
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

  cleanupAudioStart = window.overlayAPI.onAudioStart((threshold, microphoneId, mode) => {
    if (mode) {
      voiceMode.value = mode
    }
    startAudioCapture(threshold, microphoneId)
  })

  cleanupAudioStop = window.overlayAPI.onAudioStop(() => {
    stopAudioCapture()
  })

  // Real-time threshold update from settings slider
  cleanupThreshold = window.overlayAPI.onThresholdUpdate((threshold) => {
    volumeThreshold = threshold
    console.log(`[Overlay] Threshold updated in real-time: ${threshold}`)
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
  <div :class="['overlay-container', mode, voiceMode]">
    <div class="overlay-content">
      <!-- Screenshot badge -->
      <div v-if="screenshotActive" class="screenshot-badge">📷</div>

      <!-- Recording indicator -->
      <div v-if="mode === 'recording'" class="recording-indicator">
        <div class="pulse-ring"></div>
        <div class="mic-icon">{{ voiceMode === 'assistant' ? '🤖' : '🎤' }}</div>
      </div>

      <!-- Processing spinner -->
      <div v-if="mode === 'processing'" class="processing-indicator">
        <div class="spinner"></div>
      </div>

      <!-- Success check -->
      <div v-if="mode === 'success'" class="success-indicator">✓</div>

      <!-- Error icon -->
      <div v-if="mode === 'error'" class="error-indicator">✕</div>

      <!-- Text display -->
      <div class="overlay-text">{{ text }}</div>
    </div>
  </div>
</template>

<style>
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  background: transparent;
  overflow: hidden;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}

.overlay-container {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100vw;
  height: 100vh;
  padding: 12px;
}

.overlay-content {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 24px;
  border-radius: 16px;
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  background: rgba(20, 20, 20, 0.92);
  color: white;
  font-size: 14px;
  max-width: 380px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}

.screenshot-badge {
  position: absolute;
  top: -6px;
  right: -6px;
  font-size: 11px;
  line-height: 1;
  background: rgba(40, 40, 40, 0.95);
  border-radius: 8px;
  padding: 3px 4px;
  border: 1px solid rgba(255, 255, 255, 0.15);
}

/* 语音识别模式 - 蓝色主题 (默认) */
.overlay-container.recording .overlay-content {
  border: 1px solid rgba(255, 59, 48, 0.4);
}

.overlay-container.processing .overlay-content {
  border: 1px solid rgba(0, 113, 227, 0.4);
}

.overlay-container.success .overlay-content {
  border: 1px solid rgba(52, 199, 89, 0.4);
}

.overlay-container.error .overlay-content {
  border: 1px solid rgba(255, 59, 48, 0.4);
}

/* 语音助手模式 - 紫色主题 */
.overlay-container.assistant.recording .overlay-content {
  border: 1px solid rgba(175, 82, 222, 0.5);
  box-shadow: 0 8px 32px rgba(175, 82, 222, 0.15);
}

.overlay-container.assistant.processing .overlay-content {
  border: 1px solid rgba(175, 82, 222, 0.5);
  box-shadow: 0 8px 32px rgba(175, 82, 222, 0.15);
}

.overlay-container.assistant.success .overlay-content {
  border: 1px solid rgba(175, 82, 222, 0.4);
}

.overlay-container.assistant.error .overlay-content {
  border: 1px solid rgba(175, 82, 222, 0.4);
}

/* 语音助手模式 - 紫色脉冲动画 */
.overlay-container.assistant .pulse-ring {
  background: rgba(175, 82, 222, 0.3);
}

/* 语音助手模式 - 紫色spinner */
.overlay-container.assistant .spinner {
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: rgba(175, 82, 222, 0.9);
}

/* 语音助手模式 - 紫色成功指示器 */
.overlay-container.assistant .success-indicator {
  color: #af52de;
}

.recording-indicator {
  position: relative;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.pulse-ring {
  position: absolute;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: rgba(255, 59, 48, 0.3);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.6; }
  50% { transform: scale(1.4); opacity: 0; }
}

.mic-icon {
  font-size: 16px;
  position: relative;
  z-index: 1;
}

.processing-indicator {
  flex-shrink: 0;
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.success-indicator {
  color: #34c759;
  font-size: 20px;
  font-weight: bold;
  flex-shrink: 0;
}

.error-indicator {
  color: #ff3b30;
  font-size: 20px;
  font-weight: bold;
  flex-shrink: 0;
}

.overlay-text {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.4;
}
</style>
