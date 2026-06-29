/**
 * ElevenLabs TTS provider.
 *
 *   API:  POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}
 *   Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 *
 * ElevenLabs is the canonical test for the user-managed voice library
 * pattern: voices come from the account's library (premade + cloned +
 * professional + generated), not a hardcoded roster. `listVoices()`
 * hits /v1/voices on every call — the upstream is fast and there's no
 * good cache invalidation signal anyway (a freshly cloned voice should
 * appear immediately).
 *
 * Distinctive knobs (`stability`, `similarity_boost`, `style`,
 * `use_speaker_boost`, `speed`) ride through `SpeakRequest.extra` so
 * the SDK schema stays generic. Same convention as Perplexity Sonar's
 * `extra.search_recency_filter`.
 */

import {
  AuthError,
  RateLimitError,
  NetworkError,
  ProviderServerError,
  InvalidRequestError,
} from '@gezy/sdk'
import type { AuthResult, ProviderConfig } from '@gezy/sdk'
import type {
  TTSProvider,
  Voice,
  SpeakRequest,
  SpeakResult,
} from '@/server/llm/tts/types'

const API_BASE = 'https://api.elevenlabs.io/v1'

/** Default model used when the caller doesn't override via extra.model_id.
 *  multilingual_v2 is the safe pick: handles ~30 languages, all voices
 *  are eligible. eleven_v3 / eleven_turbo_v2_5 are opt-in via extra. */
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'

// ─── API types ───────────────────────────────────────────────────────────────

interface ElevenLabsVoiceLabels {
  language?: string
  gender?: string
  descriptive?: string
  accent?: string
  age?: string
  use_case?: string
}

interface ElevenLabsVoice {
  voice_id: string
  name: string
  category?: string  // 'premade' | 'cloned' | 'professional' | 'generated' | …
  description?: string
  preview_url?: string
  labels?: ElevenLabsVoiceLabels
}

interface ElevenLabsVoicesResponse {
  voices?: ElevenLabsVoice[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getApiKey(config: ProviderConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    throw new AuthError('Missing ElevenLabs API key (config.apiKey).')
  }
  return key
}

function normalizeGender(g: string | undefined): 'male' | 'female' | 'neutral' | undefined {
  if (!g) return undefined
  const lower = g.toLowerCase()
  if (lower === 'male' || lower === 'female' || lower === 'neutral') return lower
  return undefined
}

/** Build the ElevenLabs `output_format` query value from our normalized
 *  `format` + optional `sampleRate`. Returns a tuple of (query value,
 *  HTTP media type, warning) — warning surfaces when the request asked
 *  for something we can't honor verbatim. */
function buildOutputFormat(
  format: SpeakRequest['format'] | undefined,
  sampleRate: number | undefined,
): { value: string; mediaType: string; warning?: string } {
  // wav isn't natively supported by ElevenLabs — downgrade to mp3.
  if (format === 'wav') {
    return {
      value: 'mp3_44100_128',
      mediaType: 'audio/mpeg',
      warning: 'ElevenLabs does not produce WAV; downgraded to MP3 (44.1kHz 128kbps).',
    }
  }
  if (format === 'pcm') {
    const validRates = [8000, 16000, 22050, 24000, 44100]
    const rate = sampleRate && validRates.includes(sampleRate) ? sampleRate : 44100
    const warning =
      sampleRate && !validRates.includes(sampleRate)
        ? `ElevenLabs PCM sample rate must be one of ${validRates.join(', ')} — using ${rate}.`
        : undefined
    return {
      value: `pcm_${rate}`,
      mediaType: 'audio/pcm',
      ...(warning ? { warning } : {}),
    }
  }
  if (format === 'opus') {
    // ElevenLabs Opus is locked at 48kHz; expose at a sensible bitrate.
    return { value: 'opus_48000_64', mediaType: 'audio/ogg' }
  }
  // mp3 default. Pick bitrate based on sampleRate hint (22050 → 32kbps,
  // 44100 → 128kbps — matches ElevenLabs' standard tier offerings).
  if (sampleRate === 22050) {
    return { value: 'mp3_22050_32', mediaType: 'audio/mpeg' }
  }
  return { value: 'mp3_44100_128', mediaType: 'audio/mpeg' }
}

/** Construct the optional `voice_settings` payload from extra. Returns
 *  undefined when none of the recognized knobs are set (ElevenLabs
 *  applies the voice's stored defaults in that case). */
function buildVoiceSettings(
  extra: Record<string, unknown> | undefined,
  speed: number | undefined,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  if (extra) {
    if (typeof extra.stability === 'number') out.stability = extra.stability
    if (typeof extra.similarity_boost === 'number') out.similarity_boost = extra.similarity_boost
    if (typeof extra.style === 'number') out.style = extra.style
    if (typeof extra.use_speaker_boost === 'boolean') out.use_speaker_boost = extra.use_speaker_boost
  }
  // speed lives in voice_settings in newer models (eleven_v3,
  // multilingual_v2 with recent SDK). Pass it through; older models
  // ignore the field rather than reject it.
  if (speed !== undefined) out.speed = speed
  return Object.keys(out).length > 0 ? out : undefined
}

async function callElevenLabs<T>(
  url: string,
  apiKey: string,
  init: RequestInit,
  parseAs: 'json' | 'binary',
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'xi-api-key': apiKey,
        ...(init.headers ?? {}),
      },
    })
  } catch (err) {
    throw new NetworkError(
      `ElevenLabs request failed: ${err instanceof Error ? err.message : String(err)}`,
      err,
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new AuthError(`ElevenLabs authentication failed (HTTP ${response.status}).`)
  }
  if (response.status === 429) {
    throw new RateLimitError('ElevenLabs rate limit exceeded.')
  }
  if (response.status >= 500) {
    throw new ProviderServerError(
      `ElevenLabs server error (HTTP ${response.status}).`,
      response.status,
    )
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new InvalidRequestError(
      `ElevenLabs rejected the request (HTTP ${response.status}): ${body.slice(0, 300)}`,
    )
  }

  if (parseAs === 'binary') {
    const buf = await response.arrayBuffer()
    return new Uint8Array(buf) as unknown as T
  }
  return response.json() as Promise<T>
}

// ─── Provider ────────────────────────────────────────────────────────────────

export const elevenlabsTTSProvider: TTSProvider = {
  type: 'elevenlabs',
  displayName: 'ElevenLabs',
  apiKeyUrl: 'https://elevenlabs.io/app/settings/api-keys',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API Key',
      required: true,
      description: 'ElevenLabs API key (Settings → API Keys).',
    },
  ],
  capabilities: {
    supportsStreaming: false,             // batch only in v1
    supportsSSML: false,                  // ElevenLabs uses voice_settings, not SSML
    supportsInstructions: false,          // no natural-language style direction; tune via extra.stability/style
    supportsSpeedControl: true,           // newer models honor voice_settings.speed
    supportsLanguageOverride: true,       // language_code param for multilingual models
    supportedFormats: ['mp3', 'pcm', 'opus'],  // no wav natively
  },

  async authenticate(config): Promise<AuthResult> {
    let apiKey: string
    try {
      apiKey = getApiKey(config)
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }

    // /v1/models is the universally-accessible auth probe. We
    // deliberately avoid /v1/user — Workspace / Service-account API
    // keys created with TTS-only scope 401 on /v1/user despite being
    // perfectly valid keys for everything we'll actually do
    // (listVoices, text_to_speech). /v1/models is part of the base
    // tier and returns the available model catalogue without
    // burning quota.
    try {
      await callElevenLabs<unknown>(`${API_BASE}/models`, apiKey, { method: 'GET' }, 'json')
      return { valid: true }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async listVoices(config): Promise<Voice[]> {
    const apiKey = getApiKey(config)
    const body = await callElevenLabs<ElevenLabsVoicesResponse>(
      `${API_BASE}/voices`,
      apiKey,
      { method: 'GET' },
      'json',
    )

    return (body.voices ?? []).map((v): Voice => {
      const labels = v.labels ?? {}
      const descriptive = labels.descriptive
      const accent = labels.accent
      const age = labels.age
      const category = v.category

      // Compose a rich description from the labels ElevenLabs exposes —
      // helps the LLM pick the right voice for a context.
      const descParts: string[] = []
      if (descriptive) descParts.push(descriptive)
      if (age) descParts.push(age)
      if (accent) descParts.push(`${accent} accent`)
      if (category && category !== 'premade') descParts.push(`(${category})`)
      const description = descParts.length > 0
        ? descParts.join(', ')
        : v.description?.trim() || undefined

      return {
        id: v.voice_id,
        name: v.name,
        ...(labels.language ? { language: labels.language } : {}),
        ...(normalizeGender(labels.gender) ? { gender: normalizeGender(labels.gender) } : {}),
        ...(description ? { description } : {}),
        model: DEFAULT_MODEL_ID,
        ...(v.preview_url ? { previewUrl: v.preview_url } : {}),
        ...(labels && Object.keys(labels).length > 0
          ? { metadata: { ...labels, category: category ?? null } }
          : {}),
      }
    })
  },

  async speak(
    voice: Voice,
    request: SpeakRequest,
    config: ProviderConfig,
  ): Promise<SpeakResult> {
    const apiKey = getApiKey(config)
    const warnings: string[] = []

    const formatSpec = buildOutputFormat(request.format, request.sampleRate)
    if (formatSpec.warning) warnings.push(formatSpec.warning)

    // Model selection: extra.model_id wins (user override), then the
    // voice's stored model, then our safe default.
    const modelId =
      (typeof request.extra?.['model_id'] === 'string' ? (request.extra['model_id'] as string) : undefined) ??
      voice.model ??
      DEFAULT_MODEL_ID

    const voiceSettings = buildVoiceSettings(request.extra, request.speed)

    const url = new URL(`${API_BASE}/text-to-speech/${encodeURIComponent(voice.id)}`)
    url.searchParams.set('output_format', formatSpec.value)

    const body = {
      text: request.text,
      model_id: modelId,
      ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
      ...(request.lang ? { language_code: request.lang } : {}),
    }

    const audio = await callElevenLabs<Uint8Array>(
      url.toString(),
      apiKey,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/*',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: request.signal,
      },
      'binary',
    )

    return {
      audio,
      mediaType: formatSpec.mediaType,
      ...(warnings.length ? { warnings } : {}),
    }
  },
}
