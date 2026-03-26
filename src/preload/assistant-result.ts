import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { OverlayResultStat } from '../shared/types'

interface AssistantResultData {
  text: string
  detailsMarkdown?: string
  stats?: OverlayResultStat[]
  sources?: Array<{ index: number; title: string; url: string }>
  reasoningMarkdown?: string
  reasoningCollapsed?: boolean
  codeMarkdown?: string
  codeCollapsed?: boolean
  turnIndex?: number
  userMessage?: string
  isConversation?: boolean
}

const assistantResultAPI = {
  notifyReady: () => {
    ipcRenderer.send(IPC.ASSISTANT_RESULT_READY)
  },

  getLatestPayload: () =>
    ipcRenderer.invoke(IPC.ASSISTANT_RESULT_GET_LATEST) as Promise<AssistantResultData | null>,

  onUpdate: (callback: (data: AssistantResultData) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: AssistantResultData
    ) => callback(data)
    ipcRenderer.on(IPC.ASSISTANT_RESULT_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.ASSISTANT_RESULT_UPDATE, handler)
  },

  onHide: (callback: () => void) => {
    const handler = () => callback()
    ipcRenderer.on(IPC.ASSISTANT_RESULT_HIDE, handler)
    return () => ipcRenderer.removeListener(IPC.ASSISTANT_RESULT_HIDE, handler)
  },

  copyToClipboard: (text: string) => {
    ipcRenderer.send(IPC.ASSISTANT_RESULT_COPY, text)
  },

  closeWindow: () => {
    ipcRenderer.send(IPC.ASSISTANT_RESULT_CLOSE)
  },

  sendFollowUpText: (text: string) => {
    ipcRenderer.send(IPC.ASSISTANT_CONVERSATION_SEND_TEXT, text)
  },

  requestVoiceFollowUp: () => {
    ipcRenderer.send(IPC.ASSISTANT_CONVERSATION_VOICE_REQUEST)
  },

  onPipelineStatus: (callback: (status: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: string) => callback(status)
    ipcRenderer.on(IPC.PIPELINE_STATUS, handler)
    return () => ipcRenderer.removeListener(IPC.PIPELINE_STATUS, handler)
  },

  stopGeneration: () => {
    ipcRenderer.send(IPC.ASSISTANT_CONVERSATION_STOP_GENERATION)
  }
}

contextBridge.exposeInMainWorld('assistantResultAPI', assistantResultAPI)

export type AssistantResultAPI = typeof assistantResultAPI
