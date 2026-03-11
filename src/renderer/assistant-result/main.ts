declare global {
  interface Window {
    assistantResultAPI: {
      onUpdate: (callback: (text: string) => void) => () => void
      copyText: (text: string) => Promise<void>
      closeWindow: () => Promise<void>
    }
  }
}

const app = document.getElementById('app')
if (!app) {
  throw new Error('Missing app container')
}

app.innerHTML = `
  <div style="padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827;">
    <h2 style="margin: 0 0 12px; font-size: 18px;">语音助手结果</h2>
    <textarea id="resultText" readonly style="width: 100%; min-height: 260px; resize: vertical; border: 1px solid #d1d5db; border-radius: 8px; padding: 12px; line-height: 1.5; font-size: 14px;"></textarea>
    <div style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
      <button id="copyBtn" style="border: 1px solid #d1d5db; background: #fff; border-radius: 6px; padding: 8px 14px; cursor: pointer;">复制</button>
      <button id="closeBtn" style="border: 0; background: #2563eb; color: #fff; border-radius: 6px; padding: 8px 14px; cursor: pointer;">关闭</button>
    </div>
  </div>
`

const resultText = document.getElementById('resultText') as HTMLTextAreaElement
const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement
const closeBtn = document.getElementById('closeBtn') as HTMLButtonElement

window.assistantResultAPI.onUpdate((text: string) => {
  resultText.value = text
})

copyBtn.addEventListener('click', async () => {
  await window.assistantResultAPI.copyText(resultText.value)
  copyBtn.textContent = '已复制'
  setTimeout(() => {
    copyBtn.textContent = '复制'
  }, 1200)
})

closeBtn.addEventListener('click', () => {
  void window.assistantResultAPI.closeWindow()
})
