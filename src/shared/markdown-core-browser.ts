import { renderMarkdown } from './markdown-core'

;(globalThis as Record<string, unknown>).__md = (text: string) => renderMarkdown(text)
