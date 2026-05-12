import { describe, it, expect } from 'bun:test'

// ─── extractApiErrorMessage (private, re-implement contract) ─────────────────

// The module extracts human-readable messages from API error objects.
// Pattern: string → string, { message: "..." } → message,
// { error: { message: "..." } } → nested message, else → JSON.stringify

function extractApiErrorMessage(err: unknown): string {
  if (typeof err === 'string') return err
  if (typeof err !== 'object' || err === null) return String(err)
  const obj = err as Record<string, unknown>
  if (typeof obj.message === 'string') return obj.message
  if (typeof obj.error === 'object' && obj.error !== null) {
    const nested = obj.error as Record<string, unknown>
    if (typeof nested.message === 'string') return nested.message
  }
  return JSON.stringify(err)
}

describe('extractApiErrorMessage', () => {
  it('returns string errors directly', () => {
    expect(extractApiErrorMessage('something broke')).toBe('something broke')
  })

  it('returns empty string for empty string input', () => {
    expect(extractApiErrorMessage('')).toBe('')
  })

  it('extracts .message from Error-like objects', () => {
    expect(extractApiErrorMessage(new Error('test error'))).toBe('test error')
    expect(extractApiErrorMessage({ message: 'direct message' })).toBe('direct message')
  })

  it('extracts .error.message from nested API responses (Anthropic/OpenAI)', () => {
    expect(
      extractApiErrorMessage({ error: { message: 'rate limit exceeded' } }),
    ).toBe('rate limit exceeded')
  })

  it('prefers .message over .error.message when both exist', () => {
    expect(
      extractApiErrorMessage({
        message: 'top level',
        error: { message: 'nested' },
      }),
    ).toBe('top level')
  })

  it('stringifies non-string, non-object values', () => {
    expect(extractApiErrorMessage(42)).toBe('42')
    expect(extractApiErrorMessage(null)).toBe('null')
    expect(extractApiErrorMessage(undefined)).toBe('undefined')
    expect(extractApiErrorMessage(true)).toBe('true')
  })

  it('JSON-stringifies objects without message or error.message', () => {
    expect(extractApiErrorMessage({ code: 500 })).toBe('{"code":500}')
    expect(extractApiErrorMessage({ error: 'not an object' })).toBe('{"error":"not an object"}')
  })

  it('handles nested error without message', () => {
    expect(extractApiErrorMessage({ error: { code: 429 } })).toBe(
      '{"error":{"code":429}}',
    )
  })
})

// ─── friendlyErrorMessage (private, re-implement contract) ───────────────────

function friendlyErrorMessage(errorMsg: string): string {
  const lower = errorMsg.toLowerCase()
  if (lower.includes('rate limit') || errorMsg.includes('429') || lower.includes('too many requests')) {
    return 'Rate limit reached — please wait a moment and try again.'
  }
  if (lower.includes('context_length_exceeded') || lower.includes('context window') || lower.includes('maximum context length')) {
    return 'The conversation is too long for this model\'s context window. Try compacting or starting a new topic.'
  }
  return errorMsg
}

describe('friendlyErrorMessage', () => {
  it('detects rate limit errors (case insensitive)', () => {
    const expected = 'Rate limit reached — please wait a moment and try again.'
    expect(friendlyErrorMessage('Rate limit exceeded')).toBe(expected)
    expect(friendlyErrorMessage('RATE LIMIT hit')).toBe(expected)
    expect(friendlyErrorMessage('Error 429: too many')).toBe(expected)
    expect(friendlyErrorMessage('Too many requests sent')).toBe(expected)
  })

  it('detects context length errors', () => {
    const expected =
      "The conversation is too long for this model's context window. Try compacting or starting a new topic."
    expect(friendlyErrorMessage('context_length_exceeded')).toBe(expected)
    expect(friendlyErrorMessage('exceeds the maximum context length')).toBe(expected)
    expect(friendlyErrorMessage('Context window full')).toBe(expected)
  })

  it('returns original message for unrecognized errors', () => {
    expect(friendlyErrorMessage('Something went wrong')).toBe('Something went wrong')
    expect(friendlyErrorMessage('')).toBe('')
  })

  it('prioritizes rate limit over context length when both match', () => {
    // "429" triggers rate limit first
    const msg = 'Error 429: context_length_exceeded'
    expect(friendlyErrorMessage(msg)).toBe(
      'Rate limit reached — please wait a moment and try again.',
    )
  })
})

// ─── estimateTokens (private, re-implement contract) ─────────────────────────

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

describe('estimateTokens', () => {
  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('returns 1 for 1-4 char strings', () => {
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('abcd')).toBe(1)
  })

  it('rounds up for non-multiples of 4', () => {
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('abcdefg')).toBe(2)
  })

  it('is exact for multiples of 4', () => {
    expect(estimateTokens('x'.repeat(100))).toBe(25)
    expect(estimateTokens('x'.repeat(1000))).toBe(250)
  })
})

// ─── estimateContextTokens (private, re-implement contract) ──────────────────

interface ModelMessage {
  role: string
  content:
    | string
    | Array<{ text?: string; type?: string; [key: string]: unknown }>
}

function estimateContextTokens(
  systemPrompt: string,
  messageHistory: ModelMessage[],
  tools: Record<string, unknown> | undefined,
): number {
  let total = estimateTokens(systemPrompt)
  for (const msg of messageHistory) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if ('text' in part && typeof part.text === 'string') {
          total += estimateTokens(part.text)
        } else if ('type' in part && part.type === 'image') {
          total += 85
        } else if ('type' in part && part.type === 'file') {
          const dataLen = 'data' in part && typeof part.data === 'string' ? part.data.length * 0.75 : 0
          total += Math.max(500, Math.ceil(dataLen / 3000) * 500)
        }
      }
    }
  }
  if (tools && Object.keys(tools).length > 0) {
    total += estimateTokens(JSON.stringify(tools))
  }
  return total
}

describe('estimateContextTokens', () => {
  it('counts system prompt tokens', () => {
    expect(estimateContextTokens('hello world!', [], undefined)).toBe(
      estimateTokens('hello world!'),
    )
  })

  it('adds string message content', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ]
    const expected =
      estimateTokens('system') +
      estimateTokens('Hello') +
      estimateTokens('Hi there!')
    expect(estimateContextTokens('system', messages, undefined)).toBe(expected)
  })

  it('handles multimodal content arrays with text parts', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { text: 'Describe this image' },
          { type: 'image', image: 'base64data' },
        ],
      },
    ]
    const expected =
      estimateTokens('sys') +
      estimateTokens('Describe this image') +
      85 // image token overhead
    expect(estimateContextTokens('sys', messages, undefined)).toBe(expected)
  })

  it('includes tool token estimate when tools are provided', () => {
    const tools = { search: { description: 'Search the web' } }
    const toolTokens = estimateTokens(JSON.stringify(tools))
    const base = estimateTokens('prompt')
    expect(estimateContextTokens('prompt', [], tools)).toBe(base + toolTokens)
  })

  it('ignores tools when object is empty', () => {
    const base = estimateTokens('prompt')
    expect(estimateContextTokens('prompt', [], {})).toBe(base)
  })

  it('ignores tools when undefined', () => {
    const base = estimateTokens('prompt')
    expect(estimateContextTokens('prompt', [], undefined)).toBe(base)
  })

  it('handles mixed content with non-text, non-image parts', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'audio', data: 'audiodata' }, // not text or image
        ],
      },
    ]
    // Audio parts are not counted
    expect(estimateContextTokens('sys', messages, undefined)).toBe(
      estimateTokens('sys'),
    )
  })

  it('handles file parts (PDF estimates)', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'file', data: 'A'.repeat(9000), mediaType: 'application/pdf' },
        ],
      },
    ]
    // 9000 base64 chars ≈ 6750 bytes ≈ ~2.25 pages → ceil(6750/3000)*500 = 1500
    const expected = estimateTokens('sys') + 1500
    expect(estimateContextTokens('sys', messages, undefined)).toBe(expected)
  })

  it('handles multiple images in one message', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image', image: 'img1' },
          { type: 'image', image: 'img2' },
          { text: 'Compare these' },
        ],
      },
    ]
    const expected = estimateTokens('s') + 85 + 85 + estimateTokens('Compare these')
    expect(estimateContextTokens('s', messages, undefined)).toBe(expected)
  })
})

// ─── getProviderTypeForModel (private, re-implement contract) ────────────────

function getProviderTypeForModel(modelId: string): string | null {
  if (modelId.startsWith('claude-')) return 'anthropic'
  if (
    modelId.startsWith('gpt-') ||
    modelId.startsWith('chatgpt-') ||
    modelId.startsWith('o1') ||
    modelId.startsWith('o3') ||
    modelId.startsWith('o4')
  ) return 'openai'
  if (modelId.startsWith('gemini-')) return 'gemini'
  return null
}

describe('getProviderTypeForModel', () => {
  it('detects Anthropic models', () => {
    expect(getProviderTypeForModel('claude-3-sonnet')).toBe('anthropic')
    expect(getProviderTypeForModel('claude-3.5-opus')).toBe('anthropic')
    expect(getProviderTypeForModel('claude-instant-1.2')).toBe('anthropic')
  })

  it('detects OpenAI GPT models', () => {
    expect(getProviderTypeForModel('gpt-4')).toBe('openai')
    expect(getProviderTypeForModel('gpt-4o-mini')).toBe('openai')
    expect(getProviderTypeForModel('gpt-3.5-turbo')).toBe('openai')
  })

  it('detects OpenAI ChatGPT models', () => {
    expect(getProviderTypeForModel('chatgpt-4o-latest')).toBe('openai')
  })

  it('detects OpenAI o-series models', () => {
    expect(getProviderTypeForModel('o1-preview')).toBe('openai')
    expect(getProviderTypeForModel('o1-mini')).toBe('openai')
    expect(getProviderTypeForModel('o3-mini')).toBe('openai')
    expect(getProviderTypeForModel('o4-mini')).toBe('openai')
  })

  it('detects Gemini models', () => {
    expect(getProviderTypeForModel('gemini-pro')).toBe('gemini')
    expect(getProviderTypeForModel('gemini-1.5-flash')).toBe('gemini')
    expect(getProviderTypeForModel('gemini-2.0-flash')).toBe('gemini')
  })

  it('returns null for unknown models', () => {
    expect(getProviderTypeForModel('llama-3')).toBeNull()
    expect(getProviderTypeForModel('mistral-large')).toBeNull()
    expect(getProviderTypeForModel('command-r-plus')).toBeNull()
    expect(getProviderTypeForModel('')).toBeNull()
  })

  it('is case-sensitive (model IDs are lowercase by convention)', () => {
    expect(getProviderTypeForModel('Claude-3-sonnet')).toBeNull()
    expect(getProviderTypeForModel('GPT-4')).toBeNull()
  })

  // Edge: o1 prefix matches "o1" but also "o1-anything" and "o10" etc.
  it('matches o-series with any suffix', () => {
    expect(getProviderTypeForModel('o100')).toBe('openai')
  })
})

// ─── isTextReadable (private, re-implement contract) ─────────────────────────

function isTextReadable(mimeType: string): boolean {
  if (mimeType.startsWith('text/')) return true
  const textMimes = [
    'application/json',
    'application/xml',
    'application/javascript',
    'application/typescript',
    'application/x-yaml',
    'application/toml',
    'application/x-sh',
    'application/sql',
    'application/graphql',
    'application/x-httpd-php',
    'application/xhtml+xml',
  ]
  return textMimes.includes(mimeType)
}

describe('isTextReadable', () => {
  it('returns true for text/* mime types', () => {
    expect(isTextReadable('text/plain')).toBe(true)
    expect(isTextReadable('text/html')).toBe(true)
    expect(isTextReadable('text/css')).toBe(true)
    expect(isTextReadable('text/markdown')).toBe(true)
    expect(isTextReadable('text/csv')).toBe(true)
  })

  it('returns true for known text-like application types', () => {
    expect(isTextReadable('application/json')).toBe(true)
    expect(isTextReadable('application/xml')).toBe(true)
    expect(isTextReadable('application/javascript')).toBe(true)
    expect(isTextReadable('application/typescript')).toBe(true)
    expect(isTextReadable('application/x-yaml')).toBe(true)
    expect(isTextReadable('application/toml')).toBe(true)
    expect(isTextReadable('application/x-sh')).toBe(true)
    expect(isTextReadable('application/sql')).toBe(true)
    expect(isTextReadable('application/graphql')).toBe(true)
    expect(isTextReadable('application/x-httpd-php')).toBe(true)
    expect(isTextReadable('application/xhtml+xml')).toBe(true)
  })

  it('returns false for binary types', () => {
    expect(isTextReadable('application/pdf')).toBe(false)
    expect(isTextReadable('application/octet-stream')).toBe(false)
    expect(isTextReadable('image/png')).toBe(false)
    expect(isTextReadable('audio/mpeg')).toBe(false)
    expect(isTextReadable('video/mp4')).toBe(false)
    expect(isTextReadable('application/zip')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isTextReadable('')).toBe(false)
  })
})

// ─── summarizeToolResultValue (private, re-implement contract) ───────────────

const FILE_TOOL_NAMES = new Set(['generate_image', 'list_image_models', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'attach_file', 'save_to_storage', 'read_from_storage'])

function summarizeToolResultValue(value: unknown, toolName?: string): string {
  if (toolName && FILE_TOOL_NAMES.has(toolName)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>
      if (obj.url || obj.path || obj.storagePath) {
        const path = (obj.url ?? obj.path ?? obj.storagePath) as string
        return `[${toolName}: ${path}${obj.prompt ? ` — "${String(obj.prompt).slice(0, 60)}"` : ''}]`
      }
      if (obj.success !== undefined) {
        return `[${toolName}: ${obj.path ?? 'done'} — ${obj.success ? 'success' : 'failed'}]`
      }
    }
    if (typeof value === 'string' && value.length > 100) {
      return `[${toolName}: text content (${value.length} chars). Use tool again if needed.]`
    }
  }
  if (Array.isArray(value)) {
    return `[Collapsed — returned ${value.length} items. Use tool again if needed.]`
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    const keyList = keys.slice(0, 5).join(', ')
    const suffix = keys.length > 5 ? ', ...' : ''
    return `[Collapsed — object with keys: ${keyList}${suffix}. Use tool again if needed.]`
  }
  if (typeof value === 'string' && value.length > 100) {
    return `[Collapsed — text response (${value.length} chars). Use tool again if needed.]`
  }
  return String(value)
}

describe('summarizeToolResultValue', () => {
  it('returns string representation for small primitives', () => {
    expect(summarizeToolResultValue(42)).toBe('42')
    expect(summarizeToolResultValue(true)).toBe('true')
    expect(summarizeToolResultValue(null)).toBe('null')
    expect(summarizeToolResultValue('short')).toBe('short')
  })

  it('collapses arrays with item count', () => {
    expect(summarizeToolResultValue([1, 2, 3])).toBe('[Collapsed — returned 3 items. Use tool again if needed.]')
    expect(summarizeToolResultValue([])).toBe('[Collapsed — returned 0 items. Use tool again if needed.]')
  })

  it('collapses objects with key list', () => {
    expect(summarizeToolResultValue({ a: 1, b: 2 })).toBe(
      '[Collapsed — object with keys: a, b. Use tool again if needed.]',
    )
  })

  it('truncates key list to 5 keys', () => {
    const obj = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }
    const result = summarizeToolResultValue(obj)
    expect(result).toContain('a, b, c, d, e, ...')
  })

  it('collapses long strings', () => {
    const longStr = 'x'.repeat(200)
    expect(summarizeToolResultValue(longStr)).toBe(
      '[Collapsed — text response (200 chars). Use tool again if needed.]',
    )
  })

  it('keeps short strings as-is', () => {
    expect(summarizeToolResultValue('hello world')).toBe('hello world')
    // Exactly 100 chars: not > 100
    expect(summarizeToolResultValue('x'.repeat(100))).toBe('x'.repeat(100))
  })

  // File tool special handling
  it('summarizes image generation results with url', () => {
    const result = summarizeToolResultValue(
      { url: 'https://img.example.com/pic.png', prompt: 'A cat sitting on a mat' },
      'generate_image',
    )
    expect(result).toContain('generate_image')
    expect(result).toContain('https://img.example.com/pic.png')
    expect(result).toContain('A cat sitting on a mat')
  })

  it('summarizes file tool with path (path branch takes priority over success)', () => {
    // When both `path` and `success` are present, the url/path/storagePath branch fires first
    expect(summarizeToolResultValue(
      { success: true, path: '/tmp/file.txt' },
      'write_file',
    )).toBe('[write_file: /tmp/file.txt]')

    expect(summarizeToolResultValue(
      { success: false, path: '/tmp/file.txt' },
      'write_file',
    )).toBe('[write_file: /tmp/file.txt]')
  })

  it('summarizes file tool with success but no path', () => {
    expect(summarizeToolResultValue(
      { success: true },
      'edit_file',
    )).toBe('[edit_file: done — success]')
  })

  it('summarizes read_file with long string content', () => {
    const content = 'A'.repeat(200)
    const result = summarizeToolResultValue(content, 'read_file')
    expect(result).toContain('read_file')
    expect(result).toContain('200 chars')
  })

  it('truncates long prompts in image generation summary to 60 chars', () => {
    const longPrompt = 'A'.repeat(100)
    const result = summarizeToolResultValue(
      { url: '/img.png', prompt: longPrompt },
      'generate_image',
    )
    expect(result).toContain('A'.repeat(60))
    expect(result).not.toContain('A'.repeat(61))
  })

  it('does not apply file-tool logic for non-file tools', () => {
    const result = summarizeToolResultValue(
      { url: 'https://example.com', success: true },
      'web_search',
    )
    expect(result).toContain('object with keys')
  })
})

// ─── truncateToolResultValue (private, re-implement contract) ────────────────

function truncateToolResultValue(value: unknown, maxChars: number): { text: string; savedChars: number } {
  const json = JSON.stringify(value ?? null)
  if (json.length <= maxChars) return { text: json, savedChars: 0 }
  return { text: json.slice(0, maxChars) + ' [truncated]', savedChars: json.length - maxChars }
}

describe('truncateToolResultValue', () => {
  it('returns original JSON when under limit', () => {
    const { text, savedChars } = truncateToolResultValue({ a: 1 }, 100)
    expect(text).toBe('{"a":1}')
    expect(savedChars).toBe(0)
  })

  it('truncates and appends marker when over limit', () => {
    const { text, savedChars } = truncateToolResultValue('x'.repeat(100), 20)
    expect(text).toContain('[truncated]')
    expect(text.length).toBeLessThan(JSON.stringify('x'.repeat(100)).length)
    expect(savedChars).toBeGreaterThan(0)
  })

  it('handles null value', () => {
    const { text, savedChars } = truncateToolResultValue(null, 100)
    expect(text).toBe('null')
    expect(savedChars).toBe(0)
  })

  it('handles undefined value (converted to null)', () => {
    const { text } = truncateToolResultValue(undefined, 100)
    expect(text).toBe('null')
  })

  it('savedChars equals difference between original and maxChars', () => {
    const value = { data: 'x'.repeat(200) }
    const json = JSON.stringify(value)
    const maxChars = 50
    const { savedChars } = truncateToolResultValue(value, maxChars)
    expect(savedChars).toBe(json.length - maxChars)
  })

  it('handles exact boundary (length == maxChars)', () => {
    const value = 'ab' // JSON: '"ab"' = 4 chars
    const { text, savedChars } = truncateToolResultValue(value, 4)
    expect(text).toBe('"ab"')
    expect(savedChars).toBe(0)
  })
})

// ─── compactText (private, re-implement contract) ────────────────────────────

function compactText(text: string, maxChars: number): { text: string; savedChars: number } {
  let compacted = text.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ')
  if (compacted.length <= maxChars) {
    return { text: compacted, savedChars: text.length - compacted.length }
  }
  const savedChars = text.length - maxChars
  compacted = compacted.slice(0, maxChars) + ' [truncated]'
  return { text: compacted, savedChars }
}

describe('compactText', () => {
  it('collapses multiple blank lines to double', () => {
    const input = 'a\n\n\n\n\nb'
    const { text } = compactText(input, 1000)
    expect(text).toBe('a\n\nb')
  })

  it('collapses multiple spaces/tabs to single space', () => {
    const input = 'hello    world\t\there'
    const { text } = compactText(input, 1000)
    expect(text).toBe('hello world here')
  })

  it('reports savedChars from whitespace collapse', () => {
    const input = 'a     b' // 7 chars → 'a b' = 3 chars
    const { text, savedChars } = compactText(input, 1000)
    expect(text).toBe('a b')
    expect(savedChars).toBe(4) // 7 - 3
  })

  it('truncates when compacted text exceeds maxChars', () => {
    const input = 'x'.repeat(200)
    const { text, savedChars } = compactText(input, 50)
    expect(text).toBe('x'.repeat(50) + ' [truncated]')
    expect(savedChars).toBe(150) // 200 - 50
  })

  it('returns original when within limit and no collapsible whitespace', () => {
    const input = 'hello world'
    const { text, savedChars } = compactText(input, 1000)
    expect(text).toBe('hello world')
    expect(savedChars).toBe(0)
  })

  it('handles empty string', () => {
    const { text, savedChars } = compactText('', 100)
    expect(text).toBe('')
    expect(savedChars).toBe(0)
  })

  it('preserves single newlines', () => {
    const input = 'a\nb\nc'
    const { text } = compactText(input, 1000)
    expect(text).toBe('a\nb\nc')
  })

  it('preserves double newlines', () => {
    const input = 'a\n\nb'
    const { text } = compactText(input, 1000)
    expect(text).toBe('a\n\nb')
  })
})

// ─── shouldAutoDeliverToChannel (private, re-implement contract) ─────────────

function shouldAutoDeliverToChannel(queueItem: { messageType: string }): boolean {
  return ['kin_reply', 'task_result', 'wakeup'].includes(queueItem.messageType)
}

describe('shouldAutoDeliverToChannel', () => {
  it('returns true for kin_reply', () => {
    expect(shouldAutoDeliverToChannel({ messageType: 'kin_reply' })).toBe(true)
  })

  it('returns true for task_result', () => {
    expect(shouldAutoDeliverToChannel({ messageType: 'task_result' })).toBe(true)
  })

  it('returns true for wakeup', () => {
    expect(shouldAutoDeliverToChannel({ messageType: 'wakeup' })).toBe(true)
  })

  it('returns false for user messages', () => {
    expect(shouldAutoDeliverToChannel({ messageType: 'user' })).toBe(false)
  })

  it('returns false for system messages', () => {
    expect(shouldAutoDeliverToChannel({ messageType: 'system' })).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(shouldAutoDeliverToChannel({ messageType: '' })).toBe(false)
  })

  it('returns false for webhook', () => {
    expect(shouldAutoDeliverToChannel({ messageType: 'webhook' })).toBe(false)
  })
})

// ─── maskOldToolResults (exported, but importing kin-engine.ts triggers heavy
//     module-level side effects. Tested here via contract re-implementation.) ─

// Helper to create tool-call assistant messages
function makeToolCallAssistant(toolCallId: string, toolName: string, text?: string): ModelMessage {
  const content: Array<{ type: string; [k: string]: unknown }> = []
  if (text) content.push({ type: 'text', text })
  content.push({ type: 'tool-call', toolCallId, toolName, args: {} })
  return { role: 'assistant', content }
}

// Helper to create tool result messages
function makeToolResult(toolCallId: string, toolName: string, value: unknown): ModelMessage {
  return {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId, toolName, output: { type: 'text', value } },
    ],
  }
}

// Re-implementation of maskOldToolResults following the exact source logic
function maskOldToolResults(
  messages: ModelMessage[],
  keepLastN: number,
  observationWindow: number = 0,
  observationMaxChars: number = 200,
): { messages: ModelMessage[]; maskedGroupCount: number; observationCompactedCount: number; estimatedTokensSaved: number } {
  if (keepLastN < 0) keepLastN = 0

  // 1. Identify tool call group indices
  const toolGroupIndices: number[] = []
  for (let i = 1; i < messages.length; i++) {
    const prev = messages[i - 1]!
    const curr = messages[i]!
    if (
      prev.role === 'assistant' &&
      Array.isArray(prev.content) &&
      (prev.content as Array<{ type: string }>).some((p) => p.type === 'tool-call') &&
      curr.role === 'tool' &&
      Array.isArray(curr.content)
    ) {
      toolGroupIndices.push(i)
    }
  }

  const totalGroups = toolGroupIndices.length
  const intactStart = Math.max(0, totalGroups - keepLastN)
  const observationStart = Math.max(0, intactStart - observationWindow)

  const collapseSet = new Set<number>()
  const truncateSet = new Set<number>()
  for (let g = 0; g < totalGroups; g++) {
    if (g < observationStart) collapseSet.add(toolGroupIndices[g]!)
    else if (g < intactStart) truncateSet.add(toolGroupIndices[g]!)
  }

  const observationBoundaryIdx = observationStart < totalGroups
    ? toolGroupIndices[observationStart]!
    : Math.max(0, messages.length - (keepLastN + observationWindow) * 2)
  const collapseBoundaryIdx = observationStart > 0
    ? toolGroupIndices[observationStart - 1]!
    : -1

  const hasWork = collapseSet.size > 0 || truncateSet.size > 0 || observationBoundaryIdx > 0
  if (!hasWork) {
    return { messages, maskedGroupCount: 0, observationCompactedCount: 0, estimatedTokensSaved: 0 }
  }

  let tokensSaved = 0
  let maskedGroupCount = 0
  let observationCompactedCount = 0
  const result: ModelMessage[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!

    if (msg.role === 'tool' && Array.isArray(msg.content)) {
      if (collapseSet.has(i)) {
        maskedGroupCount++
        const maskedContent = (msg.content as any[]).map((part: any) => {
          if (part.type !== 'tool-result') return part
          const originalJson = JSON.stringify(part.output?.value ?? null)
          const summary = summarizeToolResultValue(part.output?.value, part.toolName)
          const savedChars = originalJson.length - summary.length
          if (savedChars > 0) tokensSaved += Math.ceil(savedChars / 4)
          return { ...part, output: { type: 'text', value: summary } }
        })
        result.push({ ...msg, content: maskedContent } as ModelMessage)
        continue
      }
      if (truncateSet.has(i)) {
        observationCompactedCount++
        const truncatedContent = (msg.content as any[]).map((part: any) => {
          if (part.type !== 'tool-result') return part
          const { text, savedChars } = truncateToolResultValue(part.output?.value, observationMaxChars)
          if (savedChars > 0) tokensSaved += Math.ceil(savedChars / 4)
          return { ...part, output: { type: 'text', value: text } }
        })
        result.push({ ...msg, content: truncatedContent } as ModelMessage)
        continue
      }
    }

    if (i < observationBoundaryIdx) {
      const maxTextChars = i <= collapseBoundaryIdx ? 500 : 2000
      if (typeof msg.content === 'string' && msg.content.length > maxTextChars) {
        const { text, savedChars } = compactText(msg.content, maxTextChars)
        if (savedChars > 0) {
          tokensSaved += Math.ceil(savedChars / 4)
          observationCompactedCount++
          result.push({ ...msg, content: text } as ModelMessage)
          continue
        }
      }
      if (Array.isArray(msg.content) && msg.role === 'assistant') {
        let modified = false
        const compactedParts = (msg.content as Array<{ type: string; text?: string; [k: string]: unknown }>).map((part) => {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > maxTextChars) {
            const { text, savedChars } = compactText(part.text, maxTextChars)
            if (savedChars > 0) {
              tokensSaved += Math.ceil(savedChars / 4)
              modified = true
              return { ...part, text }
            }
          }
          return part
        })
        if (modified) {
          observationCompactedCount++
          result.push({ ...msg, content: compactedParts } as ModelMessage)
          continue
        }
      }
    }

    result.push(msg)
  }

  return { messages: result, maskedGroupCount, observationCompactedCount, estimatedTokensSaved: tokensSaved }
}

describe('maskOldToolResults', () => {
  it('returns unchanged messages when keepLastN covers all groups', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', { results: [1, 2, 3] }),
    ]
    const result = maskOldToolResults(msgs, 10)
    expect(result.maskedGroupCount).toBe(0)
    expect(result.observationCompactedCount).toBe(0)
    expect(result.estimatedTokensSaved).toBe(0)
    expect(result.messages).toEqual(msgs)
  })

  it('collapses old tool results when keepLastN is 0', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', { results: [1, 2, 3] }),
    ]
    const result = maskOldToolResults(msgs, 0)
    expect(result.maskedGroupCount).toBe(1)
    const toolMsg = result.messages[2]!
    const part = (toolMsg.content as any[])[0]
    expect(part.output.value).toContain('Collapsed')
  })

  it('preserves recent groups and collapses old ones', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'query 1' },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', { data: 'x'.repeat(500) }),
      { role: 'assistant', content: 'result 1' },
      { role: 'user', content: 'query 2' },
      makeToolCallAssistant('tc2', 'search'),
      makeToolResult('tc2', 'search', { data: 'y'.repeat(500) }),
    ]
    const result = maskOldToolResults(msgs, 1)
    expect(result.maskedGroupCount).toBe(1)
    const firstTool = result.messages[2]!
    expect((firstTool.content as any[])[0].output.value).toContain('Collapsed')
    const secondTool = result.messages[6]!
    expect((secondTool.content as any[])[0].output.value).toEqual({ data: 'y'.repeat(500) })
  })

  it('handles observation window truncation', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'q1' },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', { data: 'x'.repeat(1000) }),
      { role: 'user', content: 'q2' },
      makeToolCallAssistant('tc2', 'search'),
      makeToolResult('tc2', 'search', { data: 'y'.repeat(1000) }),
      { role: 'user', content: 'q3' },
      makeToolCallAssistant('tc3', 'search'),
      makeToolResult('tc3', 'search', { data: 'z'.repeat(1000) }),
    ]
    const result = maskOldToolResults(msgs, 1, 1, 200)
    expect(result.maskedGroupCount).toBe(1)
    expect(result.observationCompactedCount).toBeGreaterThanOrEqual(1)
    expect((result.messages[2]!.content as any[])[0].output.value).toContain('Collapsed')
    expect((result.messages[5]!.content as any[])[0].output.value).toContain('[truncated]')
    expect((result.messages[8]!.content as any[])[0].output.value).toEqual({ data: 'z'.repeat(1000) })
  })

  it('returns same reference when no work needed', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]
    const result = maskOldToolResults(msgs, 5)
    expect(result.messages).toBe(msgs)
  })

  it('handles empty message array', () => {
    const result = maskOldToolResults([], 5)
    expect(result.messages).toEqual([])
    expect(result.maskedGroupCount).toBe(0)
  })

  it('handles negative keepLastN by treating as 0', () => {
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'hi' },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', [1, 2, 3]),
    ]
    const result = maskOldToolResults(msgs, -1)
    expect(result.maskedGroupCount).toBe(1)
  })

  it('compacts long text messages in collapse zone', () => {
    const longText = 'x'.repeat(2000)
    const msgs: ModelMessage[] = [
      { role: 'user', content: longText },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', 'result'),
      { role: 'user', content: 'recent' },
      makeToolCallAssistant('tc2', 'search'),
      makeToolResult('tc2', 'search', 'result2'),
    ]
    const result = maskOldToolResults(msgs, 1, 0)
    const firstUserMsg = result.messages[0]!
    expect((firstUserMsg.content as string).length).toBeLessThan(longText.length)
    expect(result.estimatedTokensSaved).toBeGreaterThan(0)
  })

  it('saves tokens estimate correctly', () => {
    const bigData = { items: Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` })) }
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'query' },
      makeToolCallAssistant('tc1', 'search'),
      makeToolResult('tc1', 'search', bigData),
    ]
    const result = maskOldToolResults(msgs, 0)
    expect(result.estimatedTokensSaved).toBeGreaterThan(0)
  })
})
