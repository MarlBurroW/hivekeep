---
title: "Tutorial: build a real provider plugin (Mistral AI)"
description: "A complete worked example that builds a multi-capability provider plugin for Hivekeep: an LLM provider plus a Voxtral speech-to-text provider, sharing one API-key config."
---

This tutorial builds a complete, real provider plugin end to end: `hivekeep-plugin-mistral`. It packs **two providers into one plugin**, both with `type: 'mistral'`, so a single API-key row covers both:

- an **`LLMProvider`** for chat (tool calling, vision, streaming) against `api.mistral.ai`, and
- an **`STTProvider`** for Voxtral speech-to-text.

That mirrors exactly how Hivekeep's built-in OpenAI integration works: one configured key, several capabilities (LLM + embedding + image + TTS + STT). When two providers share the same `type`, Hivekeep groups them under one configured provider row, so the user enters their key once and gets both chat and transcription.

If you want the minimal single-file plugin first, read [Developing Plugins](/hivekeep/docs/plugins/developing/) and study the shipped [`packages/sdk/examples/hello-agent`](https://github.com/MarlBurroW/hivekeep/tree/main/packages/sdk/examples/hello-agent) example, which exercises every extension point (tools, channels, providers, hooks, cards). This tutorial goes deeper on the **provider** surface specifically.

Everything here is written against the current `@hivekeep/sdk` (the package re-exports `z` from zod v4 and ships its TypeScript directly, so Bun imports it at runtime with no build step).

## What you will build

```
hivekeep-plugin-mistral/
├── plugin.json     # the manifest Hivekeep reads
├── package.json    # npm metadata + the @hivekeep/sdk peer dependency
├── index.ts        # the plugin: two providers + the default export
├── logo.svg        # brand icon served at /api/plugins/:name/logo
└── README.md       # shown in the plugin detail page
```

The fastest way to get the skeleton is the scaffolder:

```bash
bunx create-hivekeep-plugin --name hivekeep-plugin-mistral --types providers
cd hivekeep-plugin-mistral
```

The `--types providers` flag (note: it is **`--types`**, plural) seeds a single `LLMProvider` stub. We will replace its `index.ts` with the full two-provider implementation below and adjust the manifest.

## 1. The manifest (`plugin.json`)

The manifest is what Hivekeep validates and loads. Required fields: `name` (lowercase, `^[a-z0-9][a-z0-9-]*$`), `version` (semver), `description`, `main`. Everything else is optional but recommended.

```json
{
  "$schema": "https://unpkg.com/@hivekeep/sdk/schemas/plugin-manifest.schema.json",
  "name": "hivekeep-plugin-mistral",
  "displayName": "Mistral AI",
  "version": "0.1.0",
  "description": "Mistral AI provider for Hivekeep: chat models (tool calling, vision, streaming) plus Voxtral speech-to-text, via api.mistral.ai.",
  "author": "Your Name",
  "license": "MIT",
  "hivekeep": ">=0.41.0",
  "main": "index.ts",
  "icon": "🌬️",
  "iconUrl": "logo.svg",
  "tags": ["provider", "llm", "stt", "voxtral", "mistral"],
  "permissions": ["http:api.mistral.ai"]
}
```

Key fields explained:

- **`hivekeep`** is a semver range of *host* versions the plugin supports. Hivekeep checks it at activation time (`satisfiesSemver(hostVersion, range)`); a mismatch leaves the plugin installed-but-disabled with a clear error. This is independent from the SDK version (see [step 2](#2-the-package-and-why-hivekeepsdk-is-a-peer-dependency)).
- **`icon`** is an emoji shown in lists. **`iconUrl`** points at a file in the plugin directory (here `logo.svg`); Hivekeep serves it at `GET /api/plugins/hivekeep-plugin-mistral/logo` and uses it on the provider chip.
- **`permissions`** declares the hosts the plugin may reach through `ctx.http.fetch`. Only `http:*` permissions are enforced at runtime. The pattern allows `http:api.mistral.ai` (exact), `http:*.mistral.ai` (subdomains), or `http:*` (any). Calls to undeclared hosts throw a `PluginPermissionError`.

  > In this tutorial the providers call `fetch` directly (the upstream wire shape is OpenAI-compatible and small). Direct `globalThis.fetch` is **not** sandboxed by the permission system; only `ctx.http.fetch` is gated. Declaring `http:api.mistral.ai` is still correct: it documents the network surface and future-proofs the plugin if you switch to `ctx.http.fetch`. Provider classes do not receive `ctx`, so direct `fetch` is the pragmatic choice here.

- **`tags`** are free-form keywords surfaced in the plugin browser.

## 2. The package, and why `@hivekeep/sdk` is a peer dependency

```json
{
  "name": "hivekeep-plugin-mistral",
  "version": "0.1.0",
  "description": "Mistral AI provider for Hivekeep: chat models (tool calling, vision, streaming) plus Voxtral speech-to-text, via api.mistral.ai.",
  "author": "Your Name",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/your-name/hivekeep-plugin-mistral.git"
  },
  "homepage": "https://github.com/your-name/hivekeep-plugin-mistral#readme",
  "main": "index.ts",
  "files": ["index.ts", "plugin.json", "README.md", "logo.svg"],
  "keywords": ["hivekeep-plugin", "hivekeep"],
  "peerDependencies": {
    "@hivekeep/sdk": "^0.10.0"
  },
  "devDependencies": {
    "@hivekeep/sdk": "^0.10.0",
    "typescript": "^6.0.0"
  },
  "dependencies": {}
}
```

Two things matter most here.

**The `hivekeep-plugin` keyword.** Hivekeep's in-app plugin browser searches npm for `keywords:hivekeep-plugin`. Without it, your published plugin is invisible to the marketplace. (The second keyword, `hivekeep`, is convention.)

**`@hivekeep/sdk` is a `peerDependency`, never a `dependencies`.** This is not cosmetic. Hivekeep resolves `@hivekeep/sdk` against its **own** installation. If your plugin listed the SDK under `dependencies`, npm would install a **second copy** of the SDK inside the plugin. Two copies means two distinct module identities, which breaks:

- **`instanceof` on the error classes.** The host catches provider failures and branches on `err instanceof AuthError`, `err instanceof RateLimitError`, etc. If your plugin throws an `AuthError` from *its* SDK copy, the host's `instanceof` check against *its* copy returns `false`, and the error degrades to a generic failure.
- **Shared type identity.** The discriminated unions (`HivekeepMessage`, `ChatChunk`, …) must be the exact same types the host produces and consumes.

Declaring the SDK as a peer dependency tells npm "the host provides this; do not bundle your own". It also appears under `devDependencies` so `tsc` can resolve the SDK types when you typecheck the plugin repo in isolation. The peer range (`^0.10.0`) pins the **SDK** version; the manifest's `hivekeep` field pins the **host** version. They are two independent version lines.

## 3. The implementation (`index.ts`)

The whole plugin is one file. We will walk through it section by section, then show the default export that ties it together.

### 3.1 Imports and shared config schema

Import the types from `@hivekeep/sdk`. Both providers share one `ConfigField[]` schema: a single secret API key. Because both providers declare `type: 'mistral'`, that one field configures both.

```ts
import type {
  PluginContext,
  PluginExports,
  LLMProvider,
  LLMModel,
  ChatRequest,
  ChatChunk,
  HivekeepMessage,
  HivekeepMessageBlock,
  HivekeepTool,
  SystemPrompt,
  ProviderConfig,
  AuthResult,
  FinishReason,
  Usage,
  ConfigField,
  STTProvider,
  TranscriptionModel,
  TranscribeRequest,
  TranscribeResult,
} from '@hivekeep/sdk'

// One secret field, shared by both providers (chat + STT).
const CONFIG_SCHEMA: readonly ConfigField[] = [
  {
    key: 'apiKey',
    type: 'secret',
    label: 'API Key',
    required: true,
    placeholder: 'Bearer …',
    description: 'Get one at https://console.mistral.ai/api-keys',
  },
]

const API_BASE = 'https://api.mistral.ai/v1'
```

The `secret` field type is encrypted at rest and masked in the config API. At call time the host hands the provider a decrypted `ProviderConfig` (a `Record<string, string | undefined>` keyed by your `ConfigField` keys), so `config['apiKey']` is the plaintext key inside `authenticate`, `listModels`, `chat`, and `transcribe`.

### 3.2 Wire types and model classification

Mistral's REST API is OpenAI-compatible, so we describe just the slices of its wire shape we touch. We also define how to classify the `/v1/models` listing into chat-capable models with the right capability flags.

```ts
// Mistral's /v1/models lists chat, embedding, moderation, ocr, etc.
// Filter to chat-capable via the `capabilities.completion_chat` flag
// when present; fall back to a name-pattern exclusion otherwise.
const NON_CHAT_NAME_PATTERN = /(embed|moderation|ocr)/i

// Vision-capable families (Pixtral, recent large/medium with vision).
// Used as the fallback when `capabilities.vision` is missing.
const VISION_PATTERN = /^(pixtral-|mistral-medium-2|mistral-large-2)/i

interface MistralModelListing {
  data?: Array<{
    id: string
    capabilities?: {
      completion_chat?: boolean
      completion_fim?: boolean
      function_calling?: boolean
      vision?: boolean
    }
    max_context_length?: number
    /** Canonical model name. Multiple rows can share one `name`
     *  when they are aliases of the same underlying model. */
    name?: string
    aliases?: string[]
    description?: string
  }>
}

interface MistralMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface MistralTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

interface MistralChatRequest {
  model: string
  messages: MistralMessage[]
  temperature?: number
  max_tokens?: number
  tools?: MistralTool[]
  tool_choice?: 'auto' | 'none' | 'any'
  stream?: boolean
  random_seed?: number
}

interface MistralChatChunk {
  id?: string
  choices?: Array<{
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}
```

### 3.3 Converting Hivekeep messages to the Mistral wire shape

The provider owns the translation between Hivekeep's `ChatRequest` and the upstream format. Hivekeep messages are a discriminated union (`HivekeepMessage` with a `content` array of `HivekeepMessageBlock`s). Three subtleties:

1. A Hivekeep **tool result** lives as a `tool-result` block on a *user* turn, but Mistral wants it as its own message with `role: 'tool'`. So we split user turns whenever a `tool-result` block appears.
2. Multi-modal user turns (text + image) need `content` as an array; pure-text turns use the simpler string form.
3. **Thinking blocks** have no analog on Mistral, so we drop them.

```ts
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!)
  return btoa(binary)
}

function systemToMistral(system: SystemPrompt | undefined): MistralMessage | null {
  if (!system || system.length === 0) return null
  const text = system.map((b) => b.text).filter(Boolean).join('\n\n')
  if (!text) return null
  return { role: 'system', content: text }
}

function blockToMistralParts(
  block: HivekeepMessageBlock,
): Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  switch (block.type) {
    case 'text':
      return block.text ? [{ type: 'text', text: block.text }] : []
    case 'image': {
      const base64 = uint8ToBase64(block.data)
      return [{
        type: 'image_url',
        image_url: { url: `data:${block.mediaType};base64,${base64}` },
      }]
    }
    case 'tool-use':
    case 'tool-result':
    case 'thinking':
      // Handled at the message level, not as content parts.
      return []
  }
}

function messagesToMistral(messages: HivekeepMessage[]): MistralMessage[] {
  const out: MistralMessage[] = []
  for (const m of messages) {
    if (m.role === 'assistant') {
      const textParts: string[] = []
      const toolCalls: NonNullable<MistralMessage['tool_calls']> = []
      for (const b of m.content) {
        if (b.type === 'text' && b.text) textParts.push(b.text)
        else if (b.type === 'tool-use') {
          toolCalls.push({
            id: b.id,
            type: 'function',
            function: {
              name: b.name,
              arguments: typeof b.args === 'string' ? b.args : JSON.stringify(b.args ?? {}),
            },
          })
        }
      }
      const msg: MistralMessage = { role: 'assistant' }
      const text = textParts.join('\n').trim()
      if (text) msg.content = text
      if (toolCalls.length > 0) msg.tool_calls = toolCalls
      if (msg.content || msg.tool_calls) out.push(msg)
    } else {
      // user role: may mix text/image with tool-result blocks.
      const userParts: ReturnType<typeof blockToMistralParts> = []
      const flushUser = () => {
        if (userParts.length === 0) return
        out.push({
          role: 'user',
          content: userParts.length === 1 && userParts[0]!.type === 'text'
            ? userParts[0]!.text
            : [...userParts],
        })
        userParts.length = 0
      }
      for (const b of m.content) {
        if (b.type === 'tool-result') {
          flushUser()
          out.push({
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: b.content,
          })
        } else {
          for (const p of blockToMistralParts(b)) userParts.push(p)
        }
      }
      flushUser()
    }
  }
  return out
}

function toolsToMistral(tools: HivekeepTool[] | undefined): MistralTool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }))
}
```

Note `HivekeepTool.inputSchema` is already a JSON Schema object (the host normalizes the plugin tool's zod / JSON schema before any provider sees it), so it drops straight into Mistral's `function.parameters`.

### 3.4 The SSE parser and the chat stream

Mistral streams chat completions as Server-Sent Events. We hand-roll a tiny SSE framer (split on the blank-line delimiter, take the `data:` lines, stop on `[DONE]`) and convert each Mistral chunk into Hivekeep's `ChatChunk` union.

The contract Hivekeep expects from `chat()` is precise: an `AsyncIterable<ChatChunk>` that emits `text-delta` / `tool-use` / `thinking-delta` / `thinking-signature` chunks in order, and finishes with **exactly one** `finish` chunk carrying `{ reason, usage }` (or throws before reaching it).

Tool calls arrive in fragmented deltas keyed by `index`, so we accumulate `(id, name, args-string)` per index and emit one `tool-use` chunk per fully-formed call when the stream ends.

```ts
async function* parseSSE(response: Response): AsyncIterable<MistralChatChunk> {
  if (!response.body) throw new Error('Mistral returned an empty body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const rawMessage = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 2)
        const dataLines = rawMessage
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
        if (dataLines.length === 0) continue
        const payload = dataLines.join('\n')
        if (payload === '[DONE]') return
        try {
          yield JSON.parse(payload) as MistralChatChunk
        } catch {
          // Malformed event: skip rather than abort the whole stream.
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function finishReasonFromMistral(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop': return 'stop'
    case 'length':
    case 'model_length':
      return 'length'
    case 'tool_calls': return 'tool-calls'
    case 'error': return 'error'
    default: return reason ? 'unknown' : 'stop'
  }
}

class MistralError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message)
    this.name = 'MistralError'
  }
}

async function errorFromResponse(res: Response): Promise<MistralError> {
  const text = await res.text().catch(() => '')
  let message = text || res.statusText
  try {
    const parsed = JSON.parse(text) as { message?: string; error?: { message?: string } }
    message = parsed.error?.message ?? parsed.message ?? message
  } catch { /* keep raw body */ }
  return new MistralError(`Mistral ${res.status}: ${message}`, res.status)
}

async function* streamMistral(
  apiKey: string,
  body: MistralChatRequest,
  signal: AbortSignal | undefined,
): AsyncIterable<ChatChunk> {
  const res = await fetch(`${API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  })
  if (!res.ok) throw await errorFromResponse(res)

  // Tool calls arrive fragmented, keyed by index. Accumulate then flush.
  const toolCalls = new Map<number, { id: string; name: string; args: string }>()
  let usage: Usage = {}
  let finishReason: FinishReason = 'unknown'

  for await (const chunk of parseSSE(res)) {
    if (chunk.usage) {
      usage = {
        ...(chunk.usage.prompt_tokens != null ? { inputTokens: chunk.usage.prompt_tokens } : {}),
        ...(chunk.usage.completion_tokens != null ? { outputTokens: chunk.usage.completion_tokens } : {}),
      }
    }
    const choice = chunk.choices?.[0]
    if (!choice) continue
    const delta = choice.delta
    if (delta) {
      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text-delta', text: delta.content }
      }
      for (const tc of delta.tool_calls ?? []) {
        const existing = toolCalls.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) existing.id = tc.id
        if (tc.function?.name) existing.name = tc.function.name
        if (tc.function?.arguments) existing.args += tc.function.arguments
        toolCalls.set(tc.index, existing)
      }
    }
    if (choice.finish_reason) {
      finishReason = finishReasonFromMistral(choice.finish_reason)
    }
  }

  // Flush accumulated tool calls as one tool-use chunk each.
  for (const call of toolCalls.values()) {
    if (!call.name) continue
    let parsedArgs: unknown = {}
    if (call.args) {
      try { parsedArgs = JSON.parse(call.args) } catch { parsedArgs = call.args }
    }
    yield {
      type: 'tool-use',
      id: call.id || `mistral_${Math.random().toString(36).slice(2, 10)}`,
      name: call.name,
      args: parsedArgs,
    }
  }

  yield { type: 'finish', reason: finishReason, usage }
}
```

### 3.5 The LLM provider class

The `LLMProvider` interface requires `type`, `displayName`, `configSchema`, `authenticate()`, `listModels()`, and `chat()`. The optional `defaultMaxTools` and `billing` fields, plus the `ProviderUIHints` (`apiKeyUrl`, `lobehubIcon`), polish the UI and the engine's behavior.

- **`type`** is `'mistral'`. The host wraps it so the registered type becomes `plugin:hivekeep-plugin-mistral:mistral` (see [step 5](#5-how-hivekeep-loads-and-publishes-it)).
- **`lobehubIcon: 'Mistral'`** renders the official Mistral brand icon on the provider chip (Hivekeep ships a whitelist of `@lobehub/icons` names; `reactIcon` is the fallback for brands outside it).
- **`defaultMaxTools: 128`** is Mistral's documented per-request function cap. The engine resolves the effective cap per model as `model.maxTools ?? provider.defaultMaxTools ?? 128`.
- **`billing: 'per-token'`** tells auto-resolution this is a metered key (subscription providers win ties over per-token ones).

`listModels()` does real work: it dedupes Mistral's listing (which returns one row per alias all sharing a `name`), preferring the version-pinned id (`id === name`) over `-latest` aliases for reproducibility, then sets capability flags. `maxTools: 0` is the special signal for "this model cannot call tools at all" so the engine omits every tool *and* the tool-heavy prompt sections.

```ts
class MistralProvider implements LLMProvider {
  readonly type = 'mistral'
  readonly displayName = 'Mistral AI'
  readonly apiKeyUrl = 'https://console.mistral.ai/api-keys'
  readonly lobehubIcon = 'Mistral'
  readonly configSchema = CONFIG_SCHEMA
  // Mistral documents 128 as the per-request function-declaration cap.
  readonly defaultMaxTools = 128
  readonly billing = 'per-token' as const

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    const apiKey = config['apiKey']
    if (!apiKey) return { valid: false, error: 'Missing Mistral API key' }
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        const err = await errorFromResponse(res)
        return { valid: false, error: err.message }
      }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Network error' }
    }
  }

  async listModels(config: ProviderConfig): Promise<LLMModel[]> {
    const apiKey = config['apiKey']
    if (!apiKey) throw new Error('Missing Mistral API key')
    const res = await fetch(`${API_BASE}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw await errorFromResponse(res)
    const payload = (await res.json()) as MistralModelListing

    // Dedupe in two passes:
    //   1. Group by `name` (the canonical id on every row).
    //   2. Within a group, prefer the row where `id === name` (the
    //      version-pinned id, e.g. `mistral-medium-2508`) over the
    //      `-latest` alias, for reproducibility.
    const byName = new Map<string, NonNullable<MistralModelListing['data']>[number]>()
    for (const m of payload.data ?? []) {
      const groupKey = m.name ?? m.id
      const existing = byName.get(groupKey)
      if (!existing || m.id === groupKey) {
        byName.set(groupKey, m)
      }
    }

    const out: LLMModel[] = []
    for (const m of byName.values()) {
      const chatCapable = m.capabilities?.completion_chat ?? !NON_CHAT_NAME_PATTERN.test(m.id)
      if (!chatCapable) continue

      const supportsImageInput = m.capabilities?.vision ?? VISION_PATTERN.test(m.id)
      const supportsTools = m.capabilities?.function_calling ?? true

      const model: LLMModel = {
        id: m.id,
        name: m.name ?? m.id,
        contextWindow: m.max_context_length ?? 0,
        supportsImageInput,
        supportsParallelTools: true,
      }
      // 0 = "no tool calling": engine strips tools + tool prompt sections.
      if (!supportsTools) model.maxTools = 0
      out.push(model)
    }
    return out
  }

  chat(model: LLMModel, request: ChatRequest, config: ProviderConfig): AsyncIterable<ChatChunk> {
    const apiKey = config['apiKey']
    if (!apiKey) throw new Error('Missing Mistral API key')

    const messages: MistralMessage[] = []
    const sys = systemToMistral(request.system)
    if (sys) messages.push(sys)
    for (const m of messagesToMistral(request.messages)) messages.push(m)

    const body: MistralChatRequest = { model: model.id, messages }
    if (request.temperature != null) body.temperature = request.temperature
    if (request.maxOutputTokens != null) body.max_tokens = request.maxOutputTokens
    const tools = toolsToMistral(request.tools)
    if (tools) body.tools = tools

    return streamMistral(apiKey, body, request.signal)
  }
}
```

> `chat()` returns the `AsyncIterable` directly (it is not `async`). `authenticate` and `listModels` are `async` because they `await` a single response; `chat` defers all awaiting to the `streamMistral` generator it returns. Either style is fine as long as `chat` ultimately yields `ChatChunk`s.

### 3.6 The Voxtral STT provider class

The second provider implements `STTProvider`: `type`, `displayName`, `configSchema`, `capabilities`, `authenticate()`, `listModels()`, and `transcribe()`. It declares the **same `type: 'mistral'`** and the **same `CONFIG_SCHEMA`**, so it joins the LLM provider under one configured row.

`capabilities` is a static `STTCapabilities` declaration the host reads to decide which request knobs to surface and when to warn. Voxtral does language hints, auto-detect, and segment timestamps, but not diarization or prompt biasing. `listModels()` is hardcoded to the two production Voxtral variants (the `/v1/models` listing mixes chat and audio with no clean modality flag). `transcribe()` does a multipart `POST /v1/audio/transcriptions` and maps the response back into `TranscribeResult`, pushing soft `warnings` for unsupported hints rather than failing.

```ts
const VOXTRAL_MODELS: TranscriptionModel[] = [
  { id: 'voxtral-mini-2507', name: 'Voxtral Mini' },
  { id: 'voxtral-small-2507', name: 'Voxtral Small' },
]

interface VoxtralResponseSegment {
  id?: number
  start?: number
  end?: number
  text?: string
}

interface VoxtralResponse {
  text?: string
  language?: string
  duration?: number
  segments?: VoxtralResponseSegment[]
}

function extensionForMediaType(mediaType: string): string {
  const map: Record<string, string> = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
  }
  return map[mediaType.toLowerCase()] ?? 'bin'
}

class VoxtralSTTProvider implements STTProvider {
  readonly type = 'mistral'
  readonly displayName = 'Mistral (Voxtral STT)'
  readonly apiKeyUrl = 'https://console.mistral.ai/api-keys'
  readonly lobehubIcon = 'Mistral'
  readonly configSchema = CONFIG_SCHEMA
  readonly capabilities = {
    supportsLanguageHint: true,
    supportsAutoDetectLanguage: true,
    supportsDiarization: false,
    supportsTimestamps: true,
    supportsPromptBiasing: false,
    supportedAudioFormats: [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
      'audio/webm', 'audio/ogg', 'audio/flac',
      'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
    ],
    supportsStreaming: false,
  }

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    const apiKey = config['apiKey']
    if (!apiKey) return { valid: false, error: 'Missing Mistral API key' }
    // /v1/models is the cheapest auth probe: a valid key sees both
    // chat and audio models through it.
    try {
      const res = await fetch(`${API_BASE}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      })
      if (!res.ok) {
        const err = await errorFromResponse(res)
        return { valid: false, error: err.message }
      }
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Network error' }
    }
  }

  async listModels(_config: ProviderConfig): Promise<TranscriptionModel[]> {
    return VOXTRAL_MODELS
  }

  async transcribe(
    model: TranscriptionModel,
    request: TranscribeRequest,
    config: ProviderConfig,
  ): Promise<TranscribeResult> {
    const apiKey = config['apiKey']
    if (!apiKey) throw new Error('Missing Mistral API key')

    const warnings: string[] = []
    const ext = extensionForMediaType(request.audio.mediaType)
    if (ext === 'bin') {
      warnings.push(
        `Audio MIME type "${request.audio.mediaType}" not recognized; Voxtral may reject it.`,
      )
    }

    const form = new FormData()
    const file = new File([request.audio.data as BlobPart], `audio.${ext}`, {
      type: request.audio.mediaType,
    })
    form.append('file', file)
    form.append('model', model.id)
    if (request.lang) form.append('language', request.lang)
    if (request.timestamps) {
      // OpenAI-compatible convention: repeated bracketed key.
      form.append('timestamp_granularities[]', 'segment')
    }

    const res = await fetch(`${API_BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: request.signal,
    })
    if (!res.ok) throw await errorFromResponse(res)
    const data = (await res.json()) as VoxtralResponse

    const segments =
      request.timestamps && data.segments
        ? data.segments
            .filter((s): s is Required<Pick<VoxtralResponseSegment, 'start' | 'end' | 'text'>> =>
              s.start !== undefined && s.end !== undefined && typeof s.text === 'string',
            )
            .map((s) => ({ start: s.start, end: s.end, text: s.text }))
        : undefined

    if (request.diarize) {
      warnings.push('Voxtral does not support diarization; the diarize hint was ignored.')
    }

    return {
      text: data.text ?? '',
      ...(data.language ? { language: data.language } : {}),
      ...(data.duration ? { durationMs: Math.round(data.duration * 1000) } : {}),
      ...(segments && segments.length > 0 ? { segments } : {}),
      ...(warnings.length ? { warnings } : {}),
    }
  }
}
```

### 3.7 The default export

The plugin's entry point is a default-exported function that receives a typed `PluginContext` and returns a `PluginExports`. `providers` is an **array** of native provider instances (not a record). Returning both instances registers chat and STT in one shot.

```ts
export default function mistralPlugin(ctx: PluginContext): PluginExports {
  ctx.log.info('mistral plugin loaded')
  return {
    // Both providers share `type = 'mistral'`, so a single configured
    // row covers chat + Voxtral STT, exactly like the host's built-in
    // OpenAI provider covers LLM + embedding + image + TTS + STT from
    // one API-key row.
    providers: [new MistralProvider(), new VoxtralSTTProvider()],
  }
}
```

`ctx` gives you `config`, `log`, `storage`, `http`, `vault`, `manifest`, and `cards`. This plugin only logs at load; provider classes read their key from the `ProviderConfig` the host injects per call, so they do not need `ctx`.

## 4. Test it locally

Drop the folder into the host's `plugins/` directory and let the file watcher pick it up, or use the API:

```bash
# From the running Hivekeep host, hot-reload after editing files:
curl -X POST http://localhost:3000/api/plugins/reload
```

You can also install straight from a git repo without publishing (admin only):

```bash
curl -X POST http://localhost:3000/api/plugins/install \
  -H 'Content-Type: application/json' \
  -d '{"source":"git","url":"https://github.com/your-name/hivekeep-plugin-mistral.git"}'
```

Then open Settings → Providers, add the **Mistral AI** provider, paste your key (validated via `authenticate()` before saving), and the chat models plus the two Voxtral transcription models become available.

## 5. How Hivekeep loads and publishes it

### Capability auto-detection

You never declare `'llm'` or `'stt'` anywhere. When Hivekeep activates the plugin it inspects each provider in `exports.providers` and detects its family by **method presence**, in priority order:

| Method present | Detected family | Registry |
| --- | --- | --- |
| `chat` | `llm` | LLM |
| `embed` | `embedding` | Embedding |
| `generate` | `image` | Image |
| `search` | `search` | Search |
| `speak` | `tts` | TTS |
| `transcribe` | `stt` | STT |
| `sendMessage` + `listMessages` | `email` | Email |
| `listContacts` + `getContact` | `contacts` | Contacts |
| `listEvents` + `listCalendars` | `calendar` | Calendar |

So `MistralProvider` (has `chat`) lands in the LLM registry, and `VoxtralSTTProvider` (has `transcribe`) lands in the STT registry. A provider whose methods match nothing is skipped with a warning.

### The namespaced `type`

Each registered provider's `type` is wrapped so reads return `plugin:<plugin-name>:<type>`. For this plugin that is **`plugin:hivekeep-plugin-mistral:mistral`** for both providers. The prefix prevents collisions with built-ins and other plugins; your code still just declares `type = 'mistral'`. Because both providers carry the same final namespaced type, Hivekeep groups them under one configured provider row, which is why the user enters the API key once.

### Versioning checks at activation

At activation the host runs `satisfiesSemver(hostVersion, manifest.hivekeep)`. If the host is older than `>=0.41.0`, the plugin stays disabled with a readable error. The `@hivekeep/sdk` peer range is enforced by npm/bun at *install* time, not by the host at runtime. These are two separate gates.

### Publishing

Two distribution paths:

1. **npm (recommended for discovery).** Make sure `package.json` has the `hivekeep-plugin` keyword, bump the version, and publish:

   ```bash
   npm publish --access public
   ```

   The in-app browser searches npm for `keywords:hivekeep-plugin`, enriches each result from the published `plugin.json` (display name, logo), and lets an admin install it with one click. Keep `plugin.json.version` and `package.json.version` in sync: Hivekeep displays and update-checks against `plugin.json.version`, npm resolves against `package.json.version`, and the installer warns when they diverge.

2. **Install from git.** Push the repo and use the install-from-git flow shown in [step 4](#4-test-it-locally). No npm account needed; updates come from `git pull`.

> Installing from npm requires `npm` (and from git, `git`) to be available in the host's `PATH`. The production Docker image bundles both.

## Recap

- One plugin shipped **two providers** sharing **one `type` and one config field**, mirroring the built-in OpenAI pattern.
- The manifest pins the **host** version (`hivekeep`); `package.json` pins the **SDK** version as a **peer dependency** so module identity (and `instanceof` on the error classes) stays intact.
- Providers implement the **same native interfaces** Hivekeep's built-ins use (`LLMProvider`, `STTProvider`) directly from `@hivekeep/sdk`.
- Hivekeep **auto-detects** the capability family from the method set and registers each provider under `plugin:<name>:<type>`.
- Ship it via **npm** (with the `hivekeep-plugin` keyword) or **install-from-git**.

For the full surface area (tools, channels, hooks, cards, the typed context, and all nine provider families), see [Developing Plugins](/hivekeep/docs/plugins/developing/) and the [`hello-agent`](https://github.com/MarlBurroW/hivekeep/tree/main/packages/sdk/examples/hello-agent) reference example.
