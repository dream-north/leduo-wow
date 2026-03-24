import Store from 'electron-store'
import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import type { VocabularyEntry, VocabularySource } from '../shared/types'
import { IPC } from '../shared/ipc-channels'

interface VocabularySchema {
  personalEntries: VocabularyEntry[]
  sharedEntries: VocabularyEntry[]
}

export type VocabularyStore = Store<VocabularySchema>

let vocabularyStore: Store<VocabularySchema>

export function initVocabularyStore(): Store<VocabularySchema> {
  vocabularyStore = new Store<VocabularySchema>({
    name: 'vocabulary',
    defaults: {
      personalEntries: [],
      sharedEntries: []
    }
  })
  return vocabularyStore
}

function getKey(source: VocabularySource): keyof VocabularySchema {
  return source === 'personal' ? 'personalEntries' : 'sharedEntries'
}

function broadcastUpdate(): void {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.VOCABULARY_UPDATED)
    }
  })
}

export function getPersonalVocabulary(s: Store<VocabularySchema>): VocabularyEntry[] {
  return s.get('personalEntries') ?? []
}

export function getSharedVocabulary(s: Store<VocabularySchema>): VocabularyEntry[] {
  return s.get('sharedEntries') ?? []
}

export function addVocabularyEntry(
  s: Store<VocabularySchema>,
  source: VocabularySource,
  entry: Omit<VocabularyEntry, 'id' | 'createdAt' | 'updatedAt'>
): { entry: VocabularyEntry; duplicate: boolean; limitReached?: boolean } {
  const key = getKey(source)
  const entries = s.get(key) ?? []

  if (entries.length >= 200) {
    return { entry: entries[0], duplicate: false, limitReached: true }
  }

  // Check for duplicate term
  const existing = entries.find((e) => e.term === entry.term)
  if (existing) {
    return { entry: existing, duplicate: true }
  }

  const now = Date.now()
  const newEntry: VocabularyEntry = {
    id: randomUUID(),
    term: entry.term,
    description: entry.description || '',
    category: entry.category || '',
    enabled: entry.enabled ?? true,
    createdAt: now,
    updatedAt: now
  }
  entries.unshift(newEntry)
  s.set(key, entries as never)
  broadcastUpdate()
  return { entry: newEntry, duplicate: false }
}

export function updateVocabularyEntry(
  s: Store<VocabularySchema>,
  source: VocabularySource,
  id: string,
  updates: Partial<Pick<VocabularyEntry, 'term' | 'description' | 'category' | 'enabled'>>
): boolean {
  const key = getKey(source)
  const entries = s.get(key) ?? []
  const idx = entries.findIndex((e) => e.id === id)
  if (idx === -1) return false
  entries[idx] = { ...entries[idx], ...updates, updatedAt: Date.now() }
  s.set(key, entries as never)
  broadcastUpdate()
  return true
}

export function deleteVocabularyEntry(
  s: Store<VocabularySchema>,
  source: VocabularySource,
  id: string
): boolean {
  const key = getKey(source)
  const entries = s.get(key) ?? []
  const filtered = entries.filter((e) => e.id !== id)
  if (filtered.length === entries.length) return false
  s.set(key, filtered as never)
  broadcastUpdate()
  return true
}

export function importVocabularyEntries(
  s: Store<VocabularySchema>,
  source: VocabularySource,
  rawEntries: Array<{ term: string; description?: string; category?: string }>
): { added: number; skipped: number; limitReached: boolean } {
  const key = getKey(source)
  const existing = s.get(key) ?? []
  const existingTerms = new Set(existing.map((e) => e.term))
  const now = Date.now()
  let added = 0
  let skipped = 0

  for (const raw of rawEntries) {
    if (!raw.term) continue
    if (existingTerms.has(raw.term)) {
      skipped++
      continue
    }
    if (existing.length >= 200) break
    existing.push({
      id: randomUUID(),
      term: raw.term,
      description: raw.description || '',
      category: raw.category || '',
      enabled: true,
      createdAt: now,
      updatedAt: now
    })
    existingTerms.add(raw.term)
    added++
  }

  s.set(key, existing as never)
  if (added > 0) broadcastUpdate()
  return { added, skipped, limitReached: existing.length >= 200 }
}

export interface VocabularyExportData {
  version: 1
  name?: string
  exportedAt: number
  entries: Array<{ term: string; description: string; category: string }>
}

export function exportVocabularyEntries(
  s: Store<VocabularySchema>,
  source: VocabularySource,
  name?: string
): VocabularyExportData {
  const raw = s.get(getKey(source)) ?? []
  return {
    version: 1,
    ...(name ? { name } : {}),
    exportedAt: Date.now(),
    entries: raw.map((e) => ({
      term: e.term,
      description: e.description,
      category: e.category
    }))
  }
}

/**
 * Returns all enabled vocabulary entries, personal first then shared.
 */
export function getActiveVocabulary(s: Store<VocabularySchema>): VocabularyEntry[] {
  const personal = (s.get('personalEntries') ?? []).filter((e) => e.enabled)
  const shared = (s.get('sharedEntries') ?? []).filter((e) => e.enabled)
  const seen = new Set(personal.map((e) => e.term))
  const deduped = shared.filter((e) => !seen.has(e.term))
  return [...personal, ...deduped]
}

export function getVocabularyStats(s: Store<VocabularySchema>): {
  personalCount: number
  sharedCount: number
  activeCount: number
} {
  const personal = s.get('personalEntries') ?? []
  const shared = s.get('sharedEntries') ?? []
  const activeCount =
    personal.filter((e) => e.enabled).length + shared.filter((e) => e.enabled).length
  return {
    personalCount: personal.length,
    sharedCount: shared.length,
    activeCount
  }
}

/**
 * Replace all shared entries (used by cloud sync).
 */
export function replaceSharedVocabulary(
  s: Store<VocabularySchema>,
  entries: VocabularyEntry[]
): void {
  s.set('sharedEntries', entries as never)
  broadcastUpdate()
}

/**
 * Strict-sync shared entries for a given source URL.
 * Removes all existing entries with the same sourceUrl, then inserts the new ones.
 * Preserves per-entry enabled state when the term already existed.
 */
export function replaceSourceEntries(
  s: Store<VocabularySchema>,
  sourceUrl: string,
  rawEntries: Array<{ term: string; description?: string; category?: string }>
): { total: number } {
  const existing = s.get('sharedEntries') ?? []
  // Build a map of previous enabled states for this source
  const prevEnabled = new Map<string, boolean>()
  for (const e of existing) {
    if (e.sourceUrl === sourceUrl) {
      prevEnabled.set(e.term, e.enabled)
    }
  }
  // Remove old entries from this source
  const kept = existing.filter((e) => e.sourceUrl !== sourceUrl)
  // Build new entries
  const now = Date.now()
  const seen = new Set<string>()
  const newEntries: VocabularyEntry[] = []
  for (const raw of rawEntries) {
    if (!raw.term || seen.has(raw.term)) continue
    seen.add(raw.term)
    newEntries.push({
      id: randomUUID(),
      term: raw.term,
      description: raw.description || '',
      category: raw.category || '',
      enabled: prevEnabled.get(raw.term) ?? true,
      createdAt: now,
      updatedAt: now,
      sourceUrl
    })
  }
  // Enforce 200 limit across all shared entries
  const combined = [...kept, ...newEntries].slice(0, 200)
  s.set('sharedEntries', combined as never)
  broadcastUpdate()
  return { total: newEntries.length }
}

/**
 * Remove all shared entries belonging to a given source URL.
 */
export function removeSourceEntries(
  s: Store<VocabularySchema>,
  sourceUrl: string
): void {
  const existing = s.get('sharedEntries') ?? []
  const filtered = existing.filter((e) => e.sourceUrl !== sourceUrl)
  s.set('sharedEntries', filtered as never)
  broadcastUpdate()
}
