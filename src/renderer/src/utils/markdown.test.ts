import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

interface MarkdownFixture {
  name: string
  markdown: string
  html: string
}

const fixtures = JSON.parse(
  readFileSync(path.resolve(process.cwd(), 'src/shared/assistant-result-markdown-fixtures.json'), 'utf8')
) as MarkdownFixture[]

describe('renderMarkdown shared fixtures', () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(renderMarkdown(fixture.markdown)).toBe(fixture.html)
    })
  }
})
