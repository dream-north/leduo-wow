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

const style = document.createElement('style')
style.textContent = `
  :root {
    color-scheme: light;
    --bg: linear-gradient(180deg, #f6f8fc 0%, #eef2f7 100%);
    --panel: rgba(255, 255, 255, 0.9);
    --text: #111827;
    --muted: #6b7280;
    --border: #d8dee9;
    --primary: #2563eb;
    --primary-hover: #1d4ed8;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    color: var(--text);
    background: var(--bg);
    min-height: 100vh;
  }

  .page {
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100vh;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .title {
    margin: 0;
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 0.2px;
  }

  .subtitle {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .card {
    flex: 1;
    min-height: 0;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--panel);
    box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08);
    padding: 12px;
  }

  .result-text {
    width: 100%;
    height: 100%;
    border: 0;
    resize: none;
    background: transparent;
    color: var(--text);
    line-height: 1.7;
    font-size: 14px;
    outline: none;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  .btn {
    border-radius: 8px;
    font-size: 13px;
    cursor: pointer;
    padding: 8px 14px;
    border: 1px solid var(--border);
    background: #fff;
    color: var(--text);
  }

  .btn:hover {
    background: #f8fafc;
  }

  .btn-primary {
    border-color: transparent;
    background: var(--primary);
    color: #fff;
  }

  .btn-primary:hover {
    background: var(--primary-hover);
  }
`
document.head.appendChild(style)

app.innerHTML = `
  <main class="page">
    <header class="header">
      <div>
        <h2 class="title">语音助手结果</h2>
        <p class="subtitle">可复制后手动使用，或直接关闭返回继续语音输入。</p>
      </div>
    </header>
    <section class="card">
      <textarea id="resultText" class="result-text" readonly placeholder="等待语音助手结果..."></textarea>
    </section>
    <div class="actions">
      <button id="copyBtn" class="btn">复制</button>
      <button id="closeBtn" class="btn btn-primary">关闭</button>
    </div>
  </main>
`

const resultText = document.getElementById('resultText') as HTMLTextAreaElement
const copyBtn = document.getElementById('copyBtn') as HTMLButtonElement
const closeBtn = document.getElementById('closeBtn') as HTMLButtonElement

window.assistantResultAPI.onUpdate((text: string) => {
  resultText.value = text
  resultText.scrollTop = 0
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
