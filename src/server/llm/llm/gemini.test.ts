/**
 * Unit tests for the Gemini provider's pure conversion + parsing
 * paths. Network calls (authenticate, listModels, chat) are not
 * exercised here — they're covered by manual smoke against a real
 * AI Studio key when the provider is enabled in the UI.
 */

import { describe, it, expect } from 'bun:test'
import { geminiProvider } from '@/server/llm/llm/gemini'
import type { ChatRequest, KinbotMessage } from '@/server/llm/llm/types'

// We test the provider through its public surface — for the
// conversion logic we exercise a chat() call against a fetch that
// captures the outgoing request body.

describe('geminiProvider — metadata', () => {
  it('declares per-token billing and the Google AI Studio key URL', () => {
    expect(geminiProvider.type).toBe('gemini')
    expect(geminiProvider.billing).toBe('per-token')
    expect(geminiProvider.apiKeyUrl).toBe('https://aistudio.google.com/apikey')
  })

  it('declares Google\'s 128 function-declaration cap', () => {
    expect(geminiProvider.defaultMaxTools).toBe(128)
  })

  it('rejects authenticate() when no key is configured (no probe attempted)', async () => {
    const result = await geminiProvider.authenticate({})
    expect(result.valid).toBe(false)
    expect(result.error).toMatch(/missing/i)
  })
})

// ─── listModels: non-LLM modality filter ────────────────────────────────────

async function stubListModelsResponse(payload: unknown): Promise<Array<{ id: string }>> {
  const original = globalThis.fetch
  ;(globalThis as any).fetch = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  try {
    return await geminiProvider.listModels({ apiKey: 'AIza-test' })
  } finally {
    ;(globalThis as any).fetch = original
  }
}

describe('geminiProvider.listModels — modality filter', () => {
  it('keeps text-chat models', async () => {
    const models = await stubListModelsResponse({
      models: [
        {
          name: 'models/gemini-2.5-pro',
          displayName: 'Gemini 2.5 Pro',
          inputTokenLimit: 1048576,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent', 'countTokens'],
        },
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
  })

  it('filters out image-generation models even when they expose generateContent', async () => {
    // Nano Banana is technically a generateContent model — it returns
    // images via inlineData parts in the response — so the upstream
    // method-based filter doesn't catch it. Name-based modality
    // filter does.
    const models = await stubListModelsResponse({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Flash',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
        {
          name: 'models/gemini-2.5-flash-image-preview',
          displayName: 'Nano Banana',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
        {
          name: 'models/gemini-3-flash-image-edit',  // future-hypothetical
          displayName: 'Hypothetical image edit',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash'])
  })

  it('filters out TTS preview models', async () => {
    const models = await stubListModelsResponse({
      models: [
        {
          name: 'models/gemini-2.5-pro',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
        {
          name: 'models/gemini-2.5-flash-preview-tts',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-2.5-pro-preview-tts',
          supportedGenerationMethods: ['generateContent'],
        },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-pro'])
  })

  it('filters out AQA (grounded QA specialty)', async () => {
    const models = await stubListModelsResponse({
      models: [
        {
          name: 'models/aqa',
          displayName: 'AQA',
          supportedGenerationMethods: ['generateContent'],
        },
        {
          name: 'models/gemini-2.5-flash',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash'])
  })

  it('filters embedding models via the upstream method check (no generateContent)', async () => {
    // Embedding models advertise only `embedContent`, so the
    // method-based filter (which runs before the name pattern)
    // drops them. Verified explicitly so a future regression that
    // adds generateContent to embedding listings would still get
    // caught — modality pattern matches "embedding" too.
    const models = await stubListModelsResponse({
      models: [
        {
          name: 'models/text-embedding-004',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemini-embedding-001',
          supportedGenerationMethods: ['embedContent'],
        },
        {
          name: 'models/gemini-2.5-flash',
          supportedGenerationMethods: ['generateContent', 'streamGenerateContent'],
        },
      ],
    })
    expect(models.map((m) => m.id)).toEqual(['gemini-2.5-flash'])
  })
})

// ─── End-to-end shape: request body sent to streamGenerateContent ──────────

/**
 * Stub global fetch with one that captures the request body, then
 * returns a minimal SSE response so chat() can iterate to completion.
 * The point is asserting on what we SEND to Gemini.
 */
async function captureRequestBody(
  invoke: () => AsyncIterable<unknown>,
): Promise<{ url: string; init: RequestInit }> {
  const captured: { url: string; init: RequestInit } = { url: '', init: {} }
  const original = globalThis.fetch
  ;(globalThis as any).fetch = async (url: string, init: RequestInit) => {
    captured.url = url
    captured.init = init
    // Minimal SSE stream that yields one usage chunk + STOP, so chat()
    // terminates cleanly.
    const sseBody = [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":1,"totalTokenCount":6}}`,
      '',
      '',
    ].join('\n')
    return new Response(sseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }
  try {
    // Drain the stream so the request actually fires.
    for await (const _ of invoke()) { /* drain */ }
  } finally {
    ;(globalThis as any).fetch = original
  }
  return captured
}

describe('geminiProvider.chat — request shape', () => {
  const baseModel = { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash' }
  const baseConfig = { apiKey: 'AIza-test' }

  it('maps user → user and assistant → model roles', async () => {
    const request: ChatRequest = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'follow up' }] },
      ],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'follow up' }] },
    ])
  })

  it('hoists system blocks into systemInstruction (not into contents)', async () => {
    const request: ChatRequest = {
      system: [{ type: 'text', text: 'You are a helpful assistant.' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    expect(body.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are a helpful assistant.' }],
    })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  it('maps KinbotTool[] into a single tools entry with functionDeclarations', async () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools: [
        {
          name: 'get_weather',
          description: 'Look up current weather.',
          inputSchema: {
            type: 'object',
            properties: { city: { type: 'string' } },
            required: ['city'],
          },
        },
      ],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: 'Look up current weather.',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
    ])
  })

  it('encodes ImageBlock as inlineData with base64', async () => {
    // Three-byte payload [0xde, 0xad, 0xbe] base64-encodes to "3q2+".
    const request: ChatRequest = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'caption this' },
          { type: 'image', data: new Uint8Array([0xde, 0xad, 0xbe]), mediaType: 'image/png' },
        ],
      }],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    const parts = body.contents[0].parts
    expect(parts[0]).toEqual({ text: 'caption this' })
    expect(parts[1]).toEqual({
      inlineData: { mimeType: 'image/png', data: '3q2+' },
    })
  })

  it('round-trips tool-use → tool-result with the original tool name patched in', async () => {
    const messages: KinbotMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'what is the weather?' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-use', id: 'call-1', name: 'get_weather', args: { city: 'Paris' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool-result', toolUseId: 'call-1', content: '22°C sunny' }],
      },
    ]
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, { messages }, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    expect(body.contents).toHaveLength(3)
    expect(body.contents[1]).toEqual({
      role: 'model',
      parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }],
    })
    // toolUseId 'call-1' resolved to 'get_weather' via the back-scan.
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{
        functionResponse: { name: 'get_weather', response: { result: '22°C sunny' } },
      }],
    })
  })

  it('maps thinkingEffort → generationConfig.thinkingConfig.thinkingBudget', async () => {
    const cases: Array<['low' | 'medium' | 'high' | 'max', number]> = [
      ['low', 1024],
      ['medium', 4096],
      ['high', 16384],
      ['max', -1],
    ]
    for (const [effort, expectedBudget] of cases) {
      const request: ChatRequest = {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
        thinkingEffort: effort,
      }
      const captured = await captureRequestBody(() =>
        geminiProvider.chat(baseModel, request, baseConfig),
      )
      const body = JSON.parse(captured.init.body as string)
      expect(body.generationConfig.thinkingConfig).toEqual({ thinkingBudget: expectedBudget })
    }
  })

  it('omits thinkingConfig when no effort is requested (Gemini uses its own default)', async () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    expect(body.generationConfig).toBeUndefined()
  })

  it('drops thinking blocks from the message history (input-only would 400)', async () => {
    const messages: KinbotMessage[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', text: 'reasoning…' },
          { type: 'text', text: 'final answer' },
        ],
      },
    ]
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, { messages }, baseConfig),
    )
    const body = JSON.parse(captured.init.body as string)
    expect(body.contents[0].parts).toEqual([{ text: 'final answer' }])
  })

  it('uses the x-goog-api-key header (not the legacy ?key= query param)', async () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    expect((captured.init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIza-test')
    expect(captured.url).not.toContain('key=AIza-test')
  })

  it('hits the streamGenerateContent endpoint with alt=sse', async () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }],
    }
    const captured = await captureRequestBody(() =>
      geminiProvider.chat(baseModel, request, baseConfig),
    )
    expect(captured.url).toContain('/v1beta/models/gemini-2.5-flash:streamGenerateContent')
    expect(captured.url).toContain('alt=sse')
  })
})

// ─── Stream → ChatChunk parsing ─────────────────────────────────────────────

async function chunksFrom(
  sseBody: string,
): Promise<Array<unknown>> {
  const original = globalThis.fetch
  ;(globalThis as any).fetch = async () =>
    new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  try {
    const out: unknown[] = []
    for await (const c of geminiProvider.chat(
      { id: 'gemini-2.5-flash', name: 'g' },
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] },
      { apiKey: 'AIza-test' },
    )) {
      out.push(c)
    }
    return out
  } finally {
    ;(globalThis as any).fetch = original
  }
}

describe('geminiProvider.chat — SSE stream parsing', () => {
  it('yields text-delta chunks for each text part and a final finish=stop', async () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}',
      '',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":2}}',
      '',
      '',
    ].join('\n')
    const chunks = await chunksFrom(body)
    expect(chunks).toEqual([
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'finish', reason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } },
    ])
  })

  it('emits tool-use chunks for functionCall parts and finishes with tool-calls', async () => {
    const body = [
      `data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"get_weather","args":{"city":"Paris"}}}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":5}}`,
      '',
      '',
    ].join('\n')
    const chunks = await chunksFrom(body)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({
      type: 'tool-use',
      name: 'get_weather',
      args: { city: 'Paris' },
    })
    expect(chunks[1]).toMatchObject({ type: 'finish', reason: 'tool-calls' })
  })

  it('maps SAFETY finishReason to content-filter', async () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"SAFETY"}]}',
      '',
      '',
    ].join('\n')
    const chunks = await chunksFrom(body)
    const finish = chunks[chunks.length - 1] as { type: string; reason: string }
    expect(finish.type).toBe('finish')
    expect(finish.reason).toBe('content-filter')
  })

  it('maps MAX_TOKENS to length', async () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"truncated…"}]},"finishReason":"MAX_TOKENS"}]}',
      '',
      '',
    ].join('\n')
    const chunks = await chunksFrom(body)
    const finish = chunks[chunks.length - 1] as { reason: string }
    expect(finish.reason).toBe('length')
  })

  it('surfaces reasoningTokens via outputTokenDetails when Gemini reports thoughtsTokenCount', async () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"final"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3,"thoughtsTokenCount":42}}',
      '',
      '',
    ].join('\n')
    const chunks = await chunksFrom(body)
    const finish = chunks[chunks.length - 1] as { usage: { outputTokenDetails?: { reasoningTokens?: number } } }
    expect(finish.usage.outputTokenDetails?.reasoningTokens).toBe(42)
  })

  it('surfaces cached tokens via inputTokenDetails.cacheReadTokens', async () => {
    const body = [
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"x"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":1,"cachedContentTokenCount":80}}',
      '',
      '',
    ].join('\n')
    const chunks = await chunksFrom(body)
    const finish = chunks[chunks.length - 1] as { usage: { inputTokenDetails?: { cacheReadTokens?: number } } }
    expect(finish.usage.inputTokenDetails?.cacheReadTokens).toBe(80)
  })
})
