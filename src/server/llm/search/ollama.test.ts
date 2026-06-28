import { describe, expect, it } from 'bun:test'
import { ollamaSearchProvider } from './ollama'

describe('ollamaSearchProvider.search', () => {
  it('posts to /web_search and maps Ollama results', async () => {
    const originalFetch = globalThis.fetch
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        auth: headers.get('authorization'),
      })
      return new Response(JSON.stringify({
        results: [{ title: 'Ollama', url: 'https://ollama.com/', content: 'Cloud models are now available...' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }) as typeof fetch
    try {
      const result = await ollamaSearchProvider.search({ query: 'what is ollama', count: 20, answer: true, lang: 'en' }, { apiKey: 'ollama-test' })
      expect(calls[0]?.url).toBe('https://ollama.com/api/web_search')
      expect(calls[0]?.auth).toBe('Bearer ollama-test')
      expect(calls[0]?.body).toEqual({ query: 'what is ollama', max_results: 10 })
      expect(result.results).toEqual([{ title: 'Ollama', url: 'https://ollama.com/', snippet: 'Cloud models are now available...', domain: 'ollama.com' }])
      expect(result.warnings).toContain('Ollama web search does not synthesize answers; returning results only.')
      expect(result.warnings).toContain('Ollama web search does not support language filtering.')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
