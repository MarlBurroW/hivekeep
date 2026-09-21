import { describe, it, expect } from 'bun:test'

// Import may fail if drizzle-orm exports are poisoned by other test files
// (Bun mock isolation bug) — same guard as knowledge.test.ts.
let selectEmbeddingProvider: typeof import('./embeddings')['selectEmbeddingProvider']
let _mocksWorking = false
try {
  const mod = await import('./embeddings')
  selectEmbeddingProvider = mod.selectEmbeddingProvider
  selectEmbeddingProvider([], null)
  _mocksWorking = true
} catch {
  _mocksWorking = false
}

const itMocked = _mocksWorking ? it : it.skip

const provider = (id: string, capabilities: string[], isValid = true) =>
  ({ id, capabilities: JSON.stringify(capabilities), isValid })

describe('selectEmbeddingProvider', () => {
  itMocked('returns null when there is no provider at all', () => {
    expect(selectEmbeddingProvider([], null)).toBeNull()
  })

  itMocked('returns null when no provider declares the embedding capability', () => {
    const all = [provider('a', ['llm']), provider('b', ['search'])]
    expect(selectEmbeddingProvider(all, null)).toBeNull()
  })

  itMocked('falls back to the first valid embedding provider when nothing is configured', () => {
    const all = [provider('a', ['llm']), provider('b', ['llm', 'embedding']), provider('c', ['embedding'])]
    expect(selectEmbeddingProvider(all, null)?.id).toBe('b')
  })

  // ─── The bug this patch exists for ────────────────────────────────────────

  itMocked('honours the configured provider over insertion order', () => {
    const all = [provider('first', ['embedding']), provider('chosen', ['embedding'])]
    // Upstream returned 'first' here, ignoring the choice made in Settings.
    expect(selectEmbeddingProvider(all, 'chosen')?.id).toBe('chosen')
  })

  // ─── Degrading, but never silently ────────────────────────────────────────

  itMocked('falls back when the configured provider was deleted', () => {
    const all = [provider('other', ['embedding'])]
    expect(selectEmbeddingProvider(all, 'gone')?.id).toBe('other')
  })

  itMocked('falls back when the configured provider went invalid', () => {
    const all = [provider('broken', ['embedding'], false), provider('other', ['embedding'])]
    expect(selectEmbeddingProvider(all, 'broken')?.id).toBe('other')
  })

  itMocked('falls back when the configured provider cannot embed', () => {
    const all = [provider('llm-only', ['llm']), provider('other', ['embedding'])]
    expect(selectEmbeddingProvider(all, 'llm-only')?.id).toBe('other')
  })

  itMocked('returns null when the configured provider is unusable and there is no fallback', () => {
    const all = [provider('broken', ['embedding'], false)]
    expect(selectEmbeddingProvider(all, 'broken')).toBeNull()
  })

  // ─── Robustness ───────────────────────────────────────────────────────────

  itMocked('skips a provider whose capabilities column is not valid JSON', () => {
    const all = [{ id: 'junk', capabilities: 'not json', isValid: true }, provider('ok', ['embedding'])]
    expect(selectEmbeddingProvider(all, null)?.id).toBe('ok')
  })

  itMocked('never returns an invalid provider', () => {
    const all = [provider('a', ['embedding'], false), provider('b', ['embedding'], false)]
    expect(selectEmbeddingProvider(all, null)).toBeNull()
  })
})
