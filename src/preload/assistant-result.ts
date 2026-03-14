import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

const assistantResultAPI = {
  onUpdate: (callback: (data: { text: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { text: string }) => callback(data)
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
