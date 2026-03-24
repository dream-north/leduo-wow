import { replaceSourceEntries } from './vocabulary-store'
import type { VocabularyStore } from './vocabulary-store'

/**
 * Fetch vocabulary from a remote URL.
 * Supports two response formats:
 * 1. Plain array: [{ term, description?, category? }]
 * 2. Export object: { version, name?, exportedAt, entries: [{ term, description?, category? }] }
 */
async function fetchRemoteVocabulary(
  url: string,
  signal?: AbortSignal
): Promise<{ entries: Array<{ term: string; description?: string; category?: string }>; name?: string }> {
  const resp = await fetch(url, { method: 'GET', signal })
  if (!resp.ok) {
    throw new Error(`同步失败: ${resp.status} ${resp.statusText}`)
  }

  const data = await resp.json()

  // Format 1: plain array
  if (Array.isArray(data)) {
    return { entries: data }
  }

  // Format 2: export object with entries array
  if (data && typeof data === 'object' && Array.isArray(data.entries)) {
    return { entries: data.entries, name: data.name }
  }

  throw new Error('同步失败: 无法识别的数据格式')
}

/**
 * Strict-sync shared vocabulary from a single URL.
 * Replaces all entries belonging to this source with the remote data.
 */
export async function syncFromUrl(
  vocabStore: VocabularyStore,
  url: string
): Promise<{ total: number; name?: string; error?: string }> {
  if (!url) {
    return { total: 0, error: '未配置同步地址' }
  }

  try {
    const { entries: rawEntries, name } = await fetchRemoteVocabulary(url)
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
