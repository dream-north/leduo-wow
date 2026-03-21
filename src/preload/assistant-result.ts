import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { OverlayResultStat } from '../shared/types'

const assistantResultAPI = {
  getLatestPayload: () =>
    ipcRenderer.invoke(IPC.ASSISTANT_RESULT_GET_LATEST) as Promise<{
      text: string
      detailsMarkdown?: string
      stats?: OverlayResultStat[]
      sources?: Array<{ index: number; title: string; url: string }>
      reasoningMarkdown?: string
      reasoningCollapsed?: boolean
      codeMarkdown?: string
      codeCollapsed?: boolean
    } | null>,

  onUpdate: (callback: (data: {
    text: string
    detailsMarkdown?: string
    stats?: OverlayResultStat[]
    sources?: Array<{ index: number; title: string; url: string }>
    reasoningMarkdown?: string
    reasoningCollapsed?: boolean
    codeMarkdown?: string
    codeCollapsed?: boolean
  }) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      data: {
        text: string
        detailsMarkdown?: string
        stats?: OverlayResultStat[]
        sources?: Array<{ index: number; title: string; url: string }>
        reasoningMarkdown?: string
        reasoningCollapsed?: boolean
        codeMarkdown?: string
        codeCollapsed?: boolean
      }
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
  }
}

contextBridge.exposeInMainWorld('assistantResultAPI', assistantResultAPI)

export type AssistantResultAPI = typeof assistantResultAPI
