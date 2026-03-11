import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc-channels'

const assistantResultAPI = {
  onUpdate: (callback: (text: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, text: string) => callback(text)
    ipcRenderer.on(IPC.ASSISTANT_RESULT_UPDATE, handler)
    return () => ipcRenderer.removeListener(IPC.ASSISTANT_RESULT_UPDATE, handler)
  },
  copyText: (text: string) => ipcRenderer.invoke(IPC.ASSISTANT_RESULT_COPY, text),
  closeWindow: () => ipcRenderer.invoke(IPC.ASSISTANT_RESULT_CLOSE)
}

contextBridge.exposeInMainWorld('assistantResultAPI', assistantResultAPI)
