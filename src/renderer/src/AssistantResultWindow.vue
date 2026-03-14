<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

declare global {
  interface Window {
    assistantResultAPI: {
      onUpdate: (callback: (data: {
        text: string
        detailsMarkdown?: string
        sources?: Array<{ index: number; title: string; url: string }>
        reasoningMarkdown?: string
        reasoningCollapsed?: boolean
        codeMarkdown?: string
        codeCollapsed?: boolean
      }) => void) => () => void
      onHide: (callback: () => void) => () => void
      copyToClipboard: (text: string) => void
      closeWindow: () => void
    }
  }
}

const text = ref('')
const detailsMarkdown = ref('')
const sources = ref<Array<{ index: number; title: string; url: string }>>([])
const reasoningMarkdown = ref('')
const reasoningCollapsed = ref(false)
const codeMarkdown = ref('')
const codeCollapsed = ref(true)
const copied = ref(false)
let cleanupUpdate: (() => void) | null = null
let cleanupHide: (() => void) | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const copyLabel = computed(() => copied.value ? '已复制' : '复制')

function clearCopiedTimer(): void {
  if (copiedTimer) {
    clearTimeout(copiedTimer)
    copiedTimer = null
  }
}

function handleCopy(): void {
  window.assistantResultAPI.copyToClipboard(text.value)
  copied.value = true
  clearCopiedTimer()
  copiedTimer = setTimeout(() => {
    copied.value = false
    copiedTimer = null
  }, 1500)
}

function handleClose(): void {
  window.assistantResultAPI.closeWindow()
}

onMounted(() => {
  cleanupUpdate = window.assistantResultAPI.onUpdate((data) => {
    text.value = data.text
    detailsMarkdown.value = data.detailsMarkdown ?? ''
    sources.value = data.sources ?? []
    reasoningMarkdown.value = data.reasoningMarkdown ?? ''
    reasoningCollapsed.value = data.reasoningCollapsed ?? false
    codeMarkdown.value = data.codeMarkdown ?? ''
    codeCollapsed.value = data.codeCollapsed ?? true
    copied.value = false
    clearCopiedTimer()
  })

  cleanupHide = window.assistantResultAPI.onHide(() => {
    copied.value = false
    clearCopiedTimer()
  })
})

onUnmounted(() => {
  cleanupUpdate?.()
  cleanupHide?.()
  clearCopiedTimer()
})
</script>

<template>
  <div class="result-shell">
    <div class="result-card">
      <div class="result-header">
        <div>
          <p class="eyebrow">语音助手</p>
          <h1>回答结果</h1>
        </div>
        <div class="actions">
          <button class="action-btn primary" @click="handleCopy">{{ copyLabel }}</button>
          <button class="action-btn" @click="handleClose">关闭</button>
        </div>
      </div>

      <div class="result-body">
        <details v-if="reasoningMarkdown" class="result-reasoning" :open="!reasoningCollapsed">
          <summary>思考过程</summary>
          <pre class="result-reasoning-text">{{ reasoningMarkdown }}</pre>
        </details>
        <details v-if="codeMarkdown" class="result-reasoning" :open="!codeCollapsed">
          <summary>代码执行</summary>
          <pre class="result-reasoning-text">{{ codeMarkdown }}</pre>
        </details>
        <pre class="result-text">{{ text }}</pre>
        <div v-if="detailsMarkdown" class="result-meta">
          <pre class="result-meta-text">{{ detailsMarkdown }}</pre>
        </div>

        <div v-if="sources.length" class="result-sources">
          <h2>搜索来源</h2>
          <ol>
            <li v-for="source in sources" :key="source.index">
              <a :href="source.url">{{ source.title || source.url }}</a>
            </li>
          </ol>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.result-shell {
  width: 100vw;
  height: 100vh;
  padding: 14px;
  background: transparent;
}

.result-card {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 18px;
  background:
    radial-gradient(circle at top right, rgba(14, 165, 233, 0.14), transparent 32%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.98));
  box-shadow: 0 24px 60px rgba(15, 23, 42, 0.22);
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  -webkit-app-region: drag;
}

.eyebrow {
  margin-bottom: 4px;
  color: #0284c7;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

h1 {
  font-size: 18px;
  font-weight: 700;
  color: #0f172a;
}

.actions {
  display: flex;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.action-btn {
  min-width: 72px;
  padding: 8px 14px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.9);
  color: #0f172a;
  font-size: 13px;
  font-weight: 600;
}

.action-btn.primary {
  border-color: rgba(2, 132, 199, 0.24);
  background: #0284c7;
  color: #fff;
}

.result-body {
  flex: 1;
  padding: 18px 20px 20px;
  overflow: auto;
}

.result-text {
  color: #0f172a;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.result-meta {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid rgba(148, 163, 184, 0.22);
}

.result-reasoning {
  margin-bottom: 16px;
  padding: 12px 14px;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: 14px;
  background: rgba(248, 250, 252, 0.9);
}

.result-reasoning summary {
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: #0f172a;
}

.result-meta-text {
  color: #475569;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.result-reasoning-text {
  color: #64748b;
  font-size: 11px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}

.result-sources {
  margin-top: 18px;
  padding-top: 14px;
  border-top: 1px solid rgba(148, 163, 184, 0.22);
}

.result-sources h2 {
  margin-bottom: 10px;
  font-size: 13px;
  color: #0f172a;
}

.result-sources ol {
  padding-left: 18px;
}

.result-sources li + li {
  margin-top: 6px;
}

.result-sources a {
  color: #0284c7;
}
</style>
