const orderedListRegex = /^(\d+)\.\s+(.+)$/
const citationRefRegex = /\[ref_(\d+)\]/g
const inlineCodeRegex = /`([^`]+)`/g
const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
const boldRegex = /\*\*([^*]+)\*\*/g
const italicRegex = /\*([^*]+)\*/g

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function escapeAttribute(value: string): string {
  return escapeHtml(value)
}

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

function renderInline(source: string): string {
  let html = escapeHtml(source)

  html = html.replace(citationRefRegex, (_, index: string) => `<sup class="citation"><a href="#ref-${index}">${index}</a></sup>`)
  html = html.replace(inlineCodeRegex, (_, code: string) => `<code>${code}</code>`)
  html = html.replace(linkRegex, (_, label: string, href: string) => {
    const safeHref = sanitizeHref(href)
    if (!safeHref) return label
    return `<a href="${escapeAttribute(safeHref)}" target="_blank" rel="noreferrer">${label}</a>`
  })
  html = html.replace(boldRegex, (_, content: string) => `<strong>${content}</strong>`)
  html = html.replace(italicRegex, (_, content: string) => `<em>${content}</em>`)

  return html
}

function renderHeading(line: string): string | null {
  const hashes = line.match(/^#{1,4}/)?.[0] ?? ''
  if (!hashes) return null

  const content = line.slice(hashes.length).trim()
  if (!content) return null

  return `<h${hashes.length}>${renderInline(content)}</h${hashes.length}>`
}

function splitTableRow(line: string): string[] {
  const stripped = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  if (!stripped) return []
  return stripped.split('|').map((cell) => cell.trim())
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell))
}

function isTableHeader(lines: string[], index: number): boolean {
  if (index + 1 >= lines.length) return false
  const header = lines[index].trim()
  const separator = lines[index + 1].trim()
  return header.includes('|') && separator.includes('|') && isTableSeparator(separator)
}

function renderTable(lines: string[], startIndex: number): { html: string; nextIndex: number } | null {
  const headerCells = splitTableRow(lines[startIndex])
  if (headerCells.length === 0) return null

  let index = startIndex + 2
  const bodyRows: string[][] = []

  while (index < lines.length) {
    const candidate = lines[index].trim()
    if (!candidate) {
      index += 1
      continue
    }
    if (!candidate.includes('|') || isTableSeparator(candidate)) break

    const row = splitTableRow(candidate)
    if (row.length === 0) break

    bodyRows.push(row)
    index += 1
  }

  const headerHtml = headerCells.map((cell) => `<th>${renderInline(cell)}</th>`).join('')
  const bodyHtml = bodyRows
    .map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`)
    .join('')

  return {
    html: `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
    nextIndex: index
  }
}

function orderedListItem(line: string): { number: number; text: string } | null {
  const match = line.match(orderedListRegex)
  if (!match) return null

  return {
    number: Number(match[1]),
    text: match[2]
  }
}

function isUnorderedList(line: string): boolean {
  return line.startsWith('- ') || line.startsWith('* ') || line.startsWith('+ ')
}

function renderBlocks(markdown: string): string {
  const normalized = markdown.replaceAll('\r\n', '\n')
  const lines = normalized.split('\n')
  const html: string[] = []
  let index = 0

  while (index < lines.length) {
    const trimmed = lines[index].trim()

    if (!trimmed) {
      index += 1
      continue
    }

    if (trimmed.startsWith('```')) {
      index += 1
      const codeLines: string[] = []
      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        codeLines.push(lines[index])
        index += 1
      }
      html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`)
      index += 1
      continue
    }

    if (trimmed === '---' || trimmed === '***') {
      html.push('<hr>')
      index += 1
      continue
    }

    const heading = renderHeading(trimmed)
    if (heading) {
      html.push(heading)
      index += 1
      continue
    }

    if (isTableHeader(lines, index)) {
      const table = renderTable(lines, index)
      if (table) {
        html.push(table.html)
        index = table.nextIndex
        continue
      }
    }

    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = []
      while (index < lines.length) {
        const candidate = lines[index].trim()
        if (!candidate.startsWith('>')) break
        quoteLines.push(renderInline(candidate.slice(1).trim()))
        index += 1
      }
      html.push(`<blockquote>${quoteLines.join('<br>')}</blockquote>`)
      continue
    }

    if (isUnorderedList(trimmed)) {
      const items: string[] = []
      while (index < lines.length) {
        while (index < lines.length && !lines[index].trim()) {
          index += 1
        }
        if (index >= lines.length) break
        const candidate = lines[index].trim()
        if (!isUnorderedList(candidate)) break
        items.push(`<li>${renderInline(candidate.slice(2))}</li>`)
        index += 1
      }
      html.push(`<ul>${items.join('')}</ul>`)
      continue
    }

    const firstOrderedItem = orderedListItem(trimmed)
    if (firstOrderedItem) {
      const items: string[] = []
      let startNumber = firstOrderedItem.number

      while (index < lines.length) {
        while (index < lines.length && !lines[index].trim()) {
          index += 1
        }
        if (index >= lines.length) break
        const candidate = orderedListItem(lines[index].trim())
        if (!candidate) break
        if (items.length === 0) {
          startNumber = candidate.number
        }
        items.push(`<li>${renderInline(candidate.text)}</li>`)
        index += 1
      }

      const startAttribute = startNumber !== 1 ? ` start="${startNumber}"` : ''
      html.push(`<ol${startAttribute}>${items.join('')}</ol>`)
      continue
    }

    const paragraphLines: string[] = []
    while (index < lines.length) {
      const candidate = lines[index].trim()
      if (
        !candidate ||
        candidate.startsWith('#') ||
        candidate.startsWith('>') ||
        candidate.startsWith('```') ||
        candidate === '---' ||
        candidate === '***' ||
        isUnorderedList(candidate) ||
        orderedListItem(candidate) ||
        isTableHeader(lines, index)
      ) {
        break
      }

      paragraphLines.push(renderInline(candidate))
      index += 1
    }

    html.push(`<p>${paragraphLines.join('<br>')}</p>`)
  }

  return html.join('')
}

export function renderMarkdown(markdown: string): string {
  const trimmed = markdown.trim()
  if (!trimmed) return ''
  return renderBlocks(trimmed)
}
