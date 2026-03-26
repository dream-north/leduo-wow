import { replaceSourceEntries, getPersonalVocabulary } from './vocabulary-store'
import type { VocabularyStore } from './vocabulary-store'
import type { GitPlatformInfo, VocabMergeItem, VocabMergePreview } from '../shared/types'
import { readGitFile, writeGitFile, testGitToken, buildAuthenticatedUrl } from './git-platform-client'
import { parseGitPlatformUrl } from '../shared/types'

/**
 * Parse raw JSON data into vocabulary entries.
 * Supports two formats:
 * 1. Plain array: [{ term, description?, category? }]
 * 2. Export object: { version, name?, exportedAt, entries: [...] }
 */
function parseVocabularyData(
  data: unknown
): { entries: Array<{ term: string; description?: string; category?: string }>; name?: string } {
  if (Array.isArray(data)) {
    return { entries: data }
  }
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).entries)) {
    const obj = data as Record<string, unknown>
    return {
      entries: obj.entries as Array<{ term: string; description?: string; category?: string }>,
      name: obj.name as string | undefined
    }
  }
  throw new Error('无法识别的数据格式')
}

/**
 * Fetch vocabulary from a remote URL.
 */
async function fetchRemoteVocabulary(
  url: string,
  headers?: Record<string, string>,
  signal?: AbortSignal
): Promise<{ entries: Array<{ term: string; description?: string; category?: string }>; name?: string }> {
  const resp = await fetch(url, { method: 'GET', headers, signal })
  if (!resp.ok) {
    throw new Error(`同步失败: ${resp.status} ${resp.statusText}`)
  }
  const data = await resp.json()
  return parseVocabularyData(data)
}

/**
 * Strict-sync shared vocabulary from a single URL.
 * Replaces all entries belonging to this source with the remote data.
 */
export async function syncFromUrl(
  vocabStore: VocabularyStore,
  url: string,
  token?: string
): Promise<{ total: number; name?: string; error?: string }> {
  if (!url) {
    return { total: 0, error: '未配置同步地址' }
  }

  try {
    // Build fetch URL and headers based on platform
    const platformInfo = parseGitPlatformUrl(url)
    let fetchUrl = url
    let headers: Record<string, string> | undefined
    if (platformInfo?.platform === 'aone-code' && token) {
      // Prefer header auth; fallback to query param handled by buildAuthenticatedUrl
      headers = { 'PRIVATE-TOKEN': token }
    } else {
      fetchUrl = buildAuthenticatedUrl(url, platformInfo, token)
    }
    const { entries: rawEntries, name } = await fetchRemoteVocabulary(fetchUrl, headers)
    const validEntries = rawEntries.filter((e) => e.term)
    const result = replaceSourceEntries(vocabStore, url, validEntries)
    console.log(`[VocabularySync] Strict-synced from ${url}: total=${result.total}`)
    return { ...result, name }
  } catch (err) {
    const message = (err as Error).message
    console.error('[VocabularySync] Sync failed:', message)
    return { total: 0, error: message }
  }
}

/**
 * Legacy wrapper - sync using config's single URL.
 * Kept for backwards compatibility with existing IPC handler.
 */
export async function syncSharedVocabulary(
  vocabStore: VocabularyStore,
  config: { sharedVocabularySyncUrl: string }
): Promise<{ synced: number; error?: string }> {
  const result = await syncFromUrl(vocabStore, config.sharedVocabularySyncUrl)
  return { synced: result.total, error: result.error }
}

// ---------------------------------------------------------------------------
// Merge: push personal vocabulary to remote shared source
// ---------------------------------------------------------------------------

/**
 * Build a merge preview by diffing personal vocabulary against remote data.
 */
export async function previewMerge(
  vocabStore: VocabularyStore,
  platformInfo: GitPlatformInfo,
  token: string
): Promise<VocabMergePreview> {
  // Fetch remote entries
  const { content } = await readGitFile(platformInfo, token)
  const remoteData = JSON.parse(content)
  const { entries: remoteRaw } = parseVocabularyData(remoteData)
  const remoteEntries = remoteRaw.filter((e) => e.term)

  // Get personal entries
  const personalEntries = getPersonalVocabulary(vocabStore)

  // Build maps keyed by term
  const remoteMap = new Map<string, { description: string; category: string }>()
  for (const e of remoteEntries) {
    remoteMap.set(e.term, { description: e.description || '', category: e.category || '' })
  }
  const personalMap = new Map<string, { description: string; category: string }>()
  for (const e of personalEntries) {
    personalMap.set(e.term, { description: e.description, category: e.category })
  }

  // Compute diff
  const items: VocabMergeItem[] = []
  let newCount = 0
  let conflictCount = 0
  let unchangedCount = 0
  let remoteOnlyCount = 0
  const allTerms = new Set([...remoteMap.keys(), ...personalMap.keys()])

  for (const term of allTerms) {
    const personal = personalMap.get(term)
    const remote = remoteMap.get(term)

    if (personal && remote) {
      if (personal.description === remote.description && personal.category === remote.category) {
        items.push({
          term,
          description: personal.description,
          category: personal.category,
          origin: 'both',
          selected: true
        })
        unchangedCount++
      } else {
        items.push({
          term,
          description: personal.description,
          category: personal.category,
          origin: 'both',
          conflict: { personalDescription: personal.description, personalCategory: personal.category, remoteDescription: remote.description, remoteCategory: remote.category },
          selected: true
        })
        conflictCount++
      }
    } else if (personal && !remote) {
      items.push({
        term,
        description: personal.description,
        category: personal.category,
        origin: 'personal',
        selected: true
      })
      newCount++
    } else if (!personal && remote) {
      items.push({
        term,
        description: remote.description,
        category: remote.category,
        origin: 'remote',
        selected: true
      })
      remoteOnlyCount++
    }
  }

  return { items, newCount, conflictCount, unchangedCount, remoteOnlyCount }
}

/**
 * Execute the merge: upload resolved items to remote.
 */
export async function executeMerge(
  vocabStore: VocabularyStore,
  sourceUrl: string,
  platformInfo: GitPlatformInfo,
  token: string,
  resolvedItems: VocabMergeItem[]
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get current sha (needed for GitHub)
    const { sha } = await readGitFile(platformInfo, token)

    // Build final entries from selected items
    const entries: Array<{ term: string; description: string; category: string }> = []
    for (const item of resolvedItems) {
      if (!item.selected) continue
      if (item.conflict && item.resolution === 'keep-remote') {
        entries.push({
          term: item.term,
          description: item.conflict.remoteDescription,
          category: item.conflict.remoteCategory
        })
      } else {
        entries.push({
          term: item.term,
          description: item.description,
          category: item.category
        })
      }
    }

    const uploadData = {
      version: 1,
      exportedAt: Date.now(),
      entries
    }
    const jsonContent = JSON.stringify(uploadData, null, 2)

    await writeGitFile(platformInfo, token, jsonContent, sha)

    // Refresh local shared vocabulary from the updated remote
    await syncFromUrl(vocabStore, sourceUrl, token)

    console.log(`[VocabularySync] Merge pushed to ${sourceUrl}: ${entries.length} entries`)
    return { success: true }
  } catch (err) {
    const message = (err as Error).message
    console.error('[VocabularySync] Merge failed:', message)
    return { success: false, error: message }
  }
}

/**
 * Test whether a write token is valid for the given platform.
 */
export async function testWriteToken(
  platformInfo: GitPlatformInfo,
  token: string
): Promise<{ success: boolean; error?: string }> {
  return testGitToken(platformInfo, token)
}
