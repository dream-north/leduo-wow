import { Marked } from 'marked'

const citationRefRegex = /\[ref_(\d+)\]/g

function sanitizeHref(href: string): string | null {
  const trimmed = href.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#')) return trimmed

  try {
    const url = new URL(trimmed)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:') {
      return trimmed
    }
  } catch {
    return null
  }

  return null
}

const renderer: Parameters<Marked['use']>[0] = {
  renderer: {
    link({ href, title, text }) {
      const safeHref = sanitizeHref(href)
      if (!safeHref) return String(text)
      const titleAttr = title ? ` title="${title}"` : ''
      return `<a href="${safeHref}" target="_blank" rel="noreferrer"${titleAttr}>${text}</a>`
    }
  }
}

const marked = new Marked({ gfm: true, breaks: true }, renderer)

function postProcessCitations(html: string): string {
  return html.replace(
    citationRefRegex,
    (_, index: string) =>
      `<sup class="citation"><a href="#ref-${index}">${index}</a></sup>`
  )
}

export function renderMarkdown(markdown: string): string {
  const trimmed = markdown.trim()
  if (!trimmed) return ''
  const html = marked.parse(trimmed) as string
  return postProcessCitations(html)
}
