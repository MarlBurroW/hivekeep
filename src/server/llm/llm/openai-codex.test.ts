import { describe, expect, it } from 'bun:test'
import { STATIC_CODEX_MODELS, mapCodexModel, modelsCacheCandidates } from './openai-codex'
import { codexAccountIdFromTokens } from './_codex-auth'
import type { PkceTokenResponse } from './_oauth-pkce'

describe('modelsCacheCandidates', () => {
  it('tries the env HOME before REAL_HOME (macOS: /Users vs the /home/$USER fallback)', () => {
    // On macOS getRealHome() can wrongly yield /home/$USER; the real cache lives
    // under /Users/$USER, so the env HOME candidate must be searched first.
    expect(modelsCacheCandidates('/Users/tester', '/home/tester')).toEqual([
      '/Users/tester/.codex/models_cache.json',
      '/home/tester/.codex/models_cache.json',
    ])
  })

  it('dedupes when env HOME and REAL_HOME match', () => {
    expect(modelsCacheCandidates('/home/u', '/home/u')).toEqual(['/home/u/.codex/models_cache.json'])
  })

  it('falls back to REAL_HOME when env HOME is missing or relative', () => {
    expect(modelsCacheCandidates(undefined, '/home/u')).toEqual(['/home/u/.codex/models_cache.json'])
    expect(modelsCacheCandidates('relative/path', '/home/u')).toEqual(['/home/u/.codex/models_cache.json'])
  })

  it('never emits a relative candidate (drops non-absolute homes)', () => {
    expect(modelsCacheCandidates('relative/env', 'also/relative')).toEqual([])
    expect(modelsCacheCandidates(undefined, undefined)).toEqual([])
    expect(modelsCacheCandidates('/Users/t', '')).toEqual(['/Users/t/.codex/models_cache.json'])
  })
})

describe('STATIC_CODEX_MODELS (last-resort fallback catalog)', () => {
  it('ships at least one API-listable Codex slug', () => {
    expect(STATIC_CODEX_MODELS.length).toBeGreaterThan(0)
    expect(STATIC_CODEX_MODELS.every((m) => m.supported_in_api && m.visibility === 'list')).toBe(true)
  })
})

describe('mapCodexModel', () => {
  it('derives reasoning levels, image support and context window from backend metadata', () => {
    // Shape returned by GET /codex/models (verified against the live backend).
    const m = mapCodexModel({
      slug: 'gpt-5.5',
      display_name: 'GPT-5.5',
      context_window: 272000,
      supported_in_api: true,
      visibility: 'list',
      input_modalities: ['text', 'image'],
      supports_parallel_tool_calls: true,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }],
    })
    expect(m.id).toBe('gpt-5.5')
    expect(m.name).toBe('GPT-5.5')
    expect(m.contextWindow).toBe(272000)
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(m.supportsImageInput).toBe(true)
  })

  it('falls back to GPT-5 defaults when the entry omits reasoning/modalities', () => {
    const m = mapCodexModel({ slug: 'gpt-5.4-mini', supported_in_api: true, visibility: 'list' })
    expect(m.thinking?.efforts).toEqual(['low', 'medium', 'high'])
    expect(m.supportsImageInput).toBe(true)
    expect(m.name).toBe('gpt-5.4-mini')
  })

  it('drops reasoning levels the registry does not recognise', () => {
    const m = mapCodexModel({
      slug: 'x',
      supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'bogus' }, {}],
    })
    expect(m.thinking?.efforts).toEqual(['medium'])
  })
})

describe('codexAccountIdFromTokens', () => {
  function idToken(claims: Record<string, unknown>): string {
    const seg = Buffer.from(JSON.stringify(claims)).toString('base64url')
    return `header.${seg}.sig`
  }

  it('extracts chatgpt_account_id from the id_token claims', () => {
    const tokens: PkceTokenResponse = {
      accessToken: 'AT',
      raw: {},
      idToken: idToken({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acc_123' } }),
    }
    expect(codexAccountIdFromTokens(tokens)).toEqual({ accountId: 'acc_123' })
  })

  it('returns undefined when no id_token / account id is present', () => {
    expect(codexAccountIdFromTokens({ accessToken: 'AT', raw: {} })).toBeUndefined()
    expect(
      codexAccountIdFromTokens({ accessToken: 'AT', raw: {}, idToken: idToken({ sub: 'x' }) }),
    ).toBeUndefined()
  })
})
