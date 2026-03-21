<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { OverlayResultStat, OverlayResultStatKind } from '@shared/types'
import { renderMarkdown } from '@renderer/utils/markdown'

interface AssistantResultSource {
  index: number
  title: string
  url: string
}

interface AssistantResultPayload {
  text: string
  detailsMarkdown?: string
  stats?: OverlayResultStat[]
  sources?: AssistantResultSource[]
  reasoningMarkdown?: string
  reasoningCollapsed?: boolean
  codeMarkdown?: string
  codeCollapsed?: boolean
}

declare global {
  interface Window {
    assistantResultAPI?: {
      notifyReady: () => void
      getLatestPayload: () => Promise<AssistantResultPayload | null>
      onUpdate: (callback: (data: AssistantResultPayload) => void) => () => void
      onHide: (callback: () => void) => () => void
      copyToClipboard: (text: string) => void
      closeWindow: () => void
    }
  }
}

const text = ref('')
const detailsMarkdown = ref('')
const stats = ref<OverlayResultStat[]>([])
const sources = ref<AssistantResultSource[]>([])
const reasoningMarkdown = ref('')
const reasoningCollapsed = ref(false)
const codeMarkdown = ref('')
const codeCollapsed = ref(true)
const copied = ref(false)
const hoveredStatDetail = ref('')
let cleanupUpdate: (() => void) | null = null
let cleanupHide: (() => void) | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const statMeta: Record<OverlayResultStatKind, { label: string }> = {
  'tokens-total': { label: '总 Token' },
  'tokens-thinking': { label: '思考 Token' },
  'code-interpreter': { label: '代码工具' },
  'web-search': { label: '联网搜索' },
  'web-extractor': { label: '网页提取' }
}

const copyLabel = computed(() => (copied.value ? '已复制' : '复制'))
const hasAnswer = computed(() => text.value.trim().length > 0)
const answerPlaceholder = computed(() => {
  if (codeMarkdown.value.trim()) return '工具已经开始执行，稍后会在这里显示最终回答。'
  if (reasoningMarkdown.value.trim()) return '模型正在组织最终答案...'
  return '等待模型返回结果...'
})
const visibleStats = computed(() => stats.value.map((stat) => ({
  ...stat,
  meta: statMeta[stat.kind]
})))
const visibleSources = computed(() => sources.value.filter((source) => source.url))
const statDetailText = computed(() => {
  if (hoveredStatDetail.value) return hoveredStatDetail.value
  if (detailsMarkdown.value.trim()) return detailsMarkdown.value.trim()
  if (visibleStats.value.length > 0) return '将鼠标移到上方统计图标上，可以查看每项的具体说明。'
  return ''
})
const answerHtml = computed(() => renderMarkdown(text.value))
const reasoningHtml = computed(() => renderMarkdown(reasoningMarkdown.value))
const codeHtml = computed(() => renderMarkdown(codeMarkdown.value))

function clearCopiedTimer(): void {
  if (copiedTimer) {
    clearTimeout(copiedTimer)
    copiedTimer = null
  }
}

function handleCopy(): void {
  if (!window.assistantResultAPI) return
  window.assistantResultAPI.copyToClipboard(text.value)
  copied.value = true
  clearCopiedTimer()
  copiedTimer = setTimeout(() => {
    copied.value = false
    copiedTimer = null
  }, 1500)
}

function handleClose(): void {
  if (!window.assistantResultAPI) return
  window.assistantResultAPI.closeWindow()
}

function setHoveredDetail(detail: string | null): void {
  hoveredStatDetail.value = detail ?? ''
}

function applyPayload(data: AssistantResultPayload): void {
  text.value = data.text
  detailsMarkdown.value = data.detailsMarkdown ?? ''
  stats.value = data.stats ?? []
  sources.value = data.sources ?? []
  reasoningMarkdown.value = data.reasoningMarkdown ?? ''
  reasoningCollapsed.value = data.reasoningCollapsed ?? false
  codeMarkdown.value = data.codeMarkdown ?? ''
  codeCollapsed.value = data.codeCollapsed ?? true
  copied.value = false
  hoveredStatDetail.value = ''
  clearCopiedTimer()
}

onMounted(() => {
  if (!window.assistantResultAPI) {
    text.value = '# 示例回答\n\n这里会显示最终回答。现在这个示例态主要用来检查结果窗的视觉、信息层级和 Markdown 排版细节。\n\n- 支持列表\n- 支持 **强调**\n- 支持 [链接](https://example.com/source-1)'
    stats.value = [
      { kind: 'tokens-total', value: '321', detail: '总 Token 321，输入 120，输出 201' },
      { kind: 'tokens-thinking', value: '88', detail: '思考 Token 88' },
      { kind: 'web-search', value: '2', detail: '联网搜索调用 2 次' }
    ]
    reasoningMarkdown.value = '先理解用户问题，再检索相关资料，最后整理成可以直接交付的答案。'
    codeMarkdown.value = '```python\nprint("hello from tool")\n```'
    codeCollapsed.value = true
    sources.value = [
      { index: 1, title: '示例来源一', url: 'https://example.com/source-1' },
      { index: 2, title: '示例来源二', url: 'https://example.com/source-2' }
    ]
    return
  }

  let receivedLiveUpdate = false

  cleanupUpdate = window.assistantResultAPI.onUpdate((data) => {
    receivedLiveUpdate = true
    applyPayload(data)
  })

  cleanupHide = window.assistantResultAPI.onHide(() => {
    copied.value = false
    hoveredStatDetail.value = ''
    clearCopiedTimer()
  })

  window.assistantResultAPI.notifyReady()

  void window.assistantResultAPI.getLatestPayload().then((payload) => {
    if (payload && !receivedLiveUpdate) {
      applyPayload(payload)
    }
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
      <header class="result-header">
        <div class="hero-copy">
          <p class="eyebrow">语音助手</p>
          <h1>回答结果</h1>
        </div>

        <div class="actions">
          <button class="action-btn primary" @click="handleCopy">{{ copyLabel }}</button>
          <button class="action-btn" @click="handleClose">关闭</button>
        </div>
      </header>

      <div v-if="visibleStats.length || statDetailText" class="meta-strip">
        <div v-if="visibleStats.length" class="stat-badges">
          <button
            v-for="stat in visibleStats"
            :key="`${stat.kind}-${stat.detail}`"
            type="button"
            class="stat-badge"
            :aria-label="stat.meta.label"
            @mouseenter="setHoveredDetail(stat.detail)"
            @mouseleave="setHoveredDetail(null)"
            @focus="setHoveredDetail(stat.detail)"
            @blur="setHoveredDetail(null)"
          >
            <span class="stat-icon" :title="stat.meta.label" aria-hidden="true">
              <svg v-if="stat.kind === 'tokens-total'" viewBox="0 0 16 16" fill="none">
                <circle cx="5" cy="8" r="2.2" />
                <circle cx="11" cy="5.5" r="2.2" />
                <circle cx="11" cy="10.5" r="2.2" />
              </svg>
              <svg v-else-if="stat.kind === 'tokens-thinking'" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.8 9.7 5l3.5.7-2.5 2.4.5 3.5L8 10l-3.2 1.6.6-3.5L2.8 5.7 6.2 5 8 1.8Z" />
              </svg>
              <svg v-else-if="stat.kind === 'code-interpreter'" viewBox="0 0 16 16" fill="none">
                <path d="M2.5 3.2h11v9.6h-11z" />
                <path d="m5 6.1 1.9 1.9L5 9.9" />
                <path d="M8.8 10h2.2" />
              </svg>
              <svg v-else-if="stat.kind === 'web-search'" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="5.2" />
                <path d="M2.8 8h10.4" />
                <path d="M8 2.8c1.7 1.4 2.6 3.2 2.6 5.2S9.7 11.8 8 13.2" />
                <path d="M8 2.8C6.3 4.2 5.4 6 5.4 8s.9 3.8 2.6 5.2" />
              </svg>
              <svg v-else viewBox="0 0 16 16" fill="none">
                <path d="M4 2.5h5l3 3v8H4z" />
                <path d="M9 2.5v3h3" />
                <circle cx="10.8" cy="10.8" r="1.8" />
                <path d="m12.1 12.1 1.4 1.4" />
              </svg>
            </span>
            <span class="stat-value">{{ stat.value }}</span>
          </button>
        </div>

        <p v-if="statDetailText" class="stat-detail-line">{{ statDetailText }}</p>
      </div>

      <div class="result-body">
        <details v-if="reasoningMarkdown" class="panel fold-panel" :open="!reasoningCollapsed">
          <summary>
            <span>思考过程</span>
            <small>{{ reasoningCollapsed ? '已折叠' : '展开查看' }}</small>
          </summary>
          <div class="markdown-body support-markdown" v-html="reasoningHtml"></div>
        </details>

        <details v-if="codeMarkdown" class="panel fold-panel code-panel" :open="!codeCollapsed">
          <summary>
            <span>工具与代码执行</span>
            <small>{{ codeCollapsed ? '已折叠' : '展开查看' }}</small>
          </summary>
          <div class="markdown-body code-markdown" v-html="codeHtml"></div>
        </details>

        <section class="panel">
          <div class="panel-head">
            <h2>回答</h2>
            <span class="panel-kicker">{{ hasAnswer ? '最终输出' : '生成中' }}</span>
          </div>

          <div v-if="hasAnswer" class="markdown-body answer-markdown" v-html="answerHtml"></div>
          <p v-else class="result-placeholder">{{ answerPlaceholder }}</p>
        </section>

        <section v-if="visibleSources.length" class="panel sources-panel">
          <div class="panel-head">
            <h2>来源</h2>
            <span class="panel-kicker">{{ visibleSources.length }} 项</span>
          </div>
          <ol class="source-list">
            <li v-for="source in visibleSources" :id="`ref-${source.index}`" :key="`${source.index}-${source.url}`">
              <a :href="source.url" target="_blank" rel="noreferrer">{{ source.title || source.url }}</a>
              <span class="source-url">{{ source.url }}</span>
            </li>
          </ol>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
:global(html),
:global(body),
:global(#app) {
  width: 100%;
  height: 100%;
  margin: 0;
  background: transparent;
}

:global(body) {
  overflow: hidden;
  font-family: 'Aptos', 'Segoe UI Variable Text', 'Segoe UI', sans-serif;
}

.result-shell {
  width: 100vw;
  height: 100vh;
  padding: 1px;
  overflow: hidden;
}

.result-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border-radius: 22px;
  background: #f7f9fc;
  box-shadow: none;
}

.result-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 18px 22px 14px;
  border-bottom: 1px solid #e5ebf2;
  background: #fbfcfe;
  -webkit-app-region: drag;
}

.hero-copy {
  flex: 1 1 auto;
  min-width: 0;
}

.eyebrow {
  margin: 0 0 4px;
  color: #0f766e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1 {
  margin: 0;
  color: #0f172a;
  font-family: 'Segoe UI Variable Display', 'Aptos Display', 'Aptos', sans-serif;
  font-size: 22px;
  font-weight: 650;
  letter-spacing: -0.03em;
}

.actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: none;
  flex-wrap: nowrap;
  justify-content: flex-end;
  white-space: nowrap;
  -webkit-app-region: no-drag;
}

.action-btn {
  min-width: 74px;
  padding: 9px 14px;
  border: 1px solid #d6dee9;
  border-radius: 999px;
  background: #ffffff;
  color: #0f172a;
  font-size: 13px;
  font-weight: 650;
}

.action-btn.primary {
  border-color: #0f766e;
  background: #0f766e;
  color: #ffffff;
}

.meta-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 22px 10px;
  border-bottom: 1px solid #e7edf4;
  background: #f9fbfd;
}

.stat-badges {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.stat-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid #dbe4ee;
  border-radius: 12px;
  background: #eef3f8;
  color: #0f172a;
  font-size: 12px;
  font-weight: 600;
}

.stat-badge:hover,
.stat-badge:focus-visible {
  border-color: #b6c6d9;
  background: #e8eef6;
  outline: none;
}

.stat-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  color: #0f766e;
}

.stat-icon svg {
  width: 14px;
  height: 14px;
  stroke: currentColor;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.stat-value {
  line-height: 1;
}

.stat-detail-line {
  margin: 0;
  min-height: 18px;
  color: #64748b;
  font-size: 12px;
  line-height: 1.5;
}

.result-body {
  flex: 1;
  padding: 18px 22px 22px;
  overflow: auto;
}

.result-body::-webkit-scrollbar {
  width: 10px;
}

.result-body::-webkit-scrollbar-thumb {
  border: 3px solid transparent;
  border-radius: 999px;
  background: rgba(100, 116, 139, 0.24);
  background-clip: padding-box;
}

.result-body > :first-child {
  margin-top: 0;
}

.panel {
  margin-top: 14px;
  padding: 16px 18px;
  border: 1px solid #e2e8f0;
  border-radius: 18px;
  background: #ffffff;
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.panel-head h2,
.panel-kicker,
.source-url {
  margin: 0;
}

.panel-head h2 {
  color: #0f172a;
  font-size: 14px;
  font-weight: 700;
}

.panel-kicker {
  color: #0f766e;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.result-placeholder {
  margin: 0;
  color: #64748b;
  font-size: 14px;
  line-height: 1.72;
}

.fold-panel summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  list-style: none;
  color: #0f172a;
  font-size: 14px;
  font-weight: 700;
}

.fold-panel summary::-webkit-details-marker {
  display: none;
}

.fold-panel summary small {
  color: #64748b;
  font-size: 11px;
  font-weight: 600;
}

.fold-panel[open] summary {
  margin-bottom: 12px;
}

.source-list {
  margin: 0;
  padding-left: 20px;
}

.source-list li + li {
  margin-top: 10px;
}

.source-list a {
  color: #0f766e;
  font-size: 13px;
  font-weight: 650;
  text-decoration: none;
}

.source-list a:hover {
  text-decoration: underline;
}

.source-url {
  display: block;
  margin-top: 4px;
  color: #64748b;
  font-size: 11px;
  line-height: 1.45;
  word-break: break-all;
}

.markdown-body {
  color: #0f172a;
  font-size: 15px;
  line-height: 1.72;
  user-select: text;
}

.support-markdown,
.code-markdown {
  color: #475569;
  font-size: 13px;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  margin: 1.05em 0 0.4em;
  color: #0f172a;
  line-height: 1.3;
}

.markdown-body :deep(h1) {
  font-size: 1.6rem;
}

.markdown-body :deep(h2) {
  font-size: 1.28rem;
}

.markdown-body :deep(h3) {
  font-size: 1.08rem;
}

.markdown-body :deep(p) {
  margin: 0.72em 0;
}

.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: 0.8em 0;
  padding-left: 1.45em;
}

.markdown-body :deep(li + li) {
  margin-top: 0.26em;
}

.markdown-body :deep(blockquote) {
  margin: 1em 0;
  padding: 0.72em 0.9em;
  border-left: 3px solid #0284c7;
  border-radius: 12px;
  background: rgba(186, 230, 253, 0.28);
  color: #0f172a;
}

.markdown-body :deep(code) {
  padding: 0.14em 0.38em;
  border-radius: 7px;
  background: rgba(148, 163, 184, 0.18);
  font-family: 'Cascadia Code', 'SF Mono', ui-monospace, Menlo, monospace;
  font-size: 0.92em;
}

.markdown-body :deep(pre) {
  margin: 0.95em 0;
  padding: 1em 1.1em;
  border-radius: 16px;
  background: #0f172a;
  color: #e2e8f0;
  overflow: auto;
}

.markdown-body :deep(pre code) {
  padding: 0;
  background: transparent;
  color: inherit;
}

.markdown-body :deep(hr) {
  margin: 1.2em 0;
  border: none;
  border-top: 1px solid rgba(148, 163, 184, 0.35);
}

.markdown-body :deep(a) {
  color: #0284c7;
  text-decoration: none;
}

.markdown-body :deep(a:hover) {
  text-decoration: underline;
}

.markdown-body :deep(table) {
  width: 100%;
  margin: 1em 0;
  border-collapse: collapse;
  overflow: hidden;
  border: 1px solid rgba(148, 163, 184, 0.25);
  border-radius: 14px;
  background: rgba(255, 255, 255, 0.75);
}

.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 0.72em 0.82em;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
  text-align: left;
  vertical-align: top;
}

.markdown-body :deep(th) {
  background: rgba(226, 232, 240, 0.45);
  font-weight: 700;
}

.markdown-body :deep(tr:last-child td) {
  border-bottom: none;
}

.markdown-body :deep(strong) {
  font-weight: 700;
}

.markdown-body :deep(em) {
  font-style: italic;
}

.markdown-body :deep(.citation) {
  margin-left: 0.14em;
  font-size: 0.72em;
  vertical-align: super;
}

@media (max-width: 560px) {
  .result-shell {
    padding: 2px;
  }

  .meta-strip,
  .result-body,
  .result-header {
    padding-left: 16px;
    padding-right: 16px;
  }

  .actions {
    gap: 8px;
  }

  .action-btn {
    min-width: 68px;
    padding-left: 12px;
    padding-right: 12px;
  }
}
</style>
