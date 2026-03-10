import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

const overlayAPI = {
  onUpdate: (callback: (data: { text: string; mode: string; voiceMode?: 'transcription' | 'assistant'; screenshotActive?: boolean }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text: string; mode: string; voiceMode?: 'transcription' | 'assistant'; screenshotActive?: boolean }) =>
      callback(data)
    ipcRenderer.on(IPC.OVERLAY_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.OVERLAY_UPDATE, handler)
  },

  // Audio recording control
  onAudioStart: (callback: (threshold: number, microphoneId: string, voiceMode?: 'transcription' | 'assistant') => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threshold: number, microphoneId: string, voiceMode?: 'transcription' | 'assistant') => callback(threshold ?? 0, microphoneId ?? '', voiceMode)
    ipcRenderer.on(IPC.AUDIO_START, handler)
    return () => ipcRenderer.removeListener(IPC.AUDIO_START, handler)
  },

  onAudioStop: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.AUDIO_STOP, handler)
    return () => ipcRenderer.removeListener(IPC.AUDIO_STOP, handler)
  },

  // Send audio chunk to main process
  sendAudioChunk: (chunk: ArrayBuffer) => {
    ipcRenderer.send(IPC.AUDIO_CHUNK, chunk)
  },

  // Report audio capture error to main process
  sendAudioError: (message: string) => {
    ipcRenderer.send(IPC.AUDIO_CAPTURE_ERROR, message)
  },

  // Real-time threshold update from settings
  onThresholdUpdate: (callback: (threshold: number) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, threshold: number) => callback(threshold)
    ipcRenderer.on(IPC.AUDIO_THRESHOLD, handler)
    return () => ipcRenderer.removeListener(IPC.AUDIO_THRESHOLD, handler)
  }
}

contextBridge.exposeInMainWorld('overlayAPI', overlayAPI)

export type OverlayAPI = typeof overlayAPI
