/**
 * ElevenLabs Scribe STT provider.
 *
 *   API:  POST https://api.elevenlabs.io/v1/speech-to-text
 *   Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 *
 * Scribe is ElevenLabs's transcription engine. Distinctive vs Whisper:
 * native speaker diarization (per-word speaker labels), audio-event
 * tagging (laughter / music), and word/character-level timestamps.
 *
 * Two models in the catalogue today:
 *   - scribe_v1              — production
 *   - scribe_v1_experimental — newer features ahead of GA
 *
 * Implemented as a separate class from the TTS provider but sharing
 * the same `type = 'elevenlabs'` so a single API-key row covers both
 * families — same pattern OpenAI uses across LLM / Embedding / Image
 * / TTS / STT.
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
  STTProvider,
  TranscriptionModel,
  TranscribeRequest,
  TranscribeResult,
} from '@/server/llm/stt/types'

const API_BASE = 'https://api.elevenlabs.io/v1'

const KNOWN_MODELS: TranscriptionModel[] = [
  {
    id: 'scribe_v1',
    name: 'Scribe v1',
    // No documented duration cap from ElevenLabs at the time of writing;
    // large files are handled (long-form transcription is a sold use
    // case). Leave maxAudioSeconds undefined so the host doesn't
    // pre-emptively split.
  },
  {
    id: 'scribe_v1_experimental',
    name: 'Scribe v1 (experimental)',
  },
]

interface ScribeWord {
  text?: string
  start?: number
  end?: number
  type?: 'word' | 'spacing' | 'audio_event'
  speaker_id?: string
}

interface ScribeResponse {
  text?: string
  language_code?: string
  language_probability?: number
  words?: ScribeWord[]
}

function getApiKey(config: ProviderConfig): string {
  const key = (config.apiKey ?? '').trim()
  if (!key) {
    throw new AuthError('Missing ElevenLabs API key (config.apiKey).')
  }
  return key
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

async function callScribe(
  formData: FormData,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ScribeResponse> {
  let response: Response
  try {
    response = await fetch(`${API_BASE}/speech-to-text`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: formData,
      signal,
    })
  } catch (err) {
    throw new NetworkError(
      `ElevenLabs Scribe request failed: ${err instanceof Error ? err.message : String(err)}`,
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
      `ElevenLabs Scribe rejected the request (HTTP ${response.status}): ${body.slice(0, 300)}`,
    )
  }

  return response.json() as Promise<ScribeResponse>
}

/**
 * Roll up Scribe's word-level granularity into segments.
 *
 * Scribe returns a flat array of word/spacing/audio_event entries with
 * per-entry start/end + speaker_id. Our SDK shape wants segments
 * (start, end, text, optional speaker). We aggregate runs of
 * consecutive words sharing the same speaker into one segment;
 * audio_event entries become their own annotated segments
 * (text like '[laughter]' so the LLM sees them inline).
 */
function buildSegments(words: ScribeWord[]): Array<{ start: number; end: number; text: string; speaker?: string }> {
  if (!words || words.length === 0) return []
  const segments: Array<{ start: number; end: number; text: string; speaker?: string }> = []
  let current: { start: number; end: number; text: string; speaker?: string } | null = null

  for (const w of words) {
    if (w.start === undefined || w.end === undefined) continue
    const txt = w.text ?? ''

    if (w.type === 'audio_event') {
      if (current) {
        segments.push(current)
        current = null
      }
      segments.push({
        start: w.start,
        end: w.end,
        text: txt.startsWith('[') ? txt : `[${txt}]`,
      })
      continue
    }

    if (!current) {
      current = {
        start: w.start,
        end: w.end,
        text: txt,
        ...(w.speaker_id ? { speaker: w.speaker_id } : {}),
      }
      continue
    }

    // Same speaker (or both unspeakered) and within reasonable gap → extend.
    const sameSpeaker = (current.speaker ?? null) === (w.speaker_id ?? null)
    if (sameSpeaker) {
      current.end = w.end
      current.text += txt
    } else {
      segments.push(current)
      current = {
        start: w.start,
        end: w.end,
        text: txt,
        ...(w.speaker_id ? { speaker: w.speaker_id } : {}),
      }
    }
  }
  if (current) segments.push(current)
  return segments.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text.length > 0)
}

export const elevenlabsSTTProvider: STTProvider = {
  type: 'elevenlabs',
  displayName: 'ElevenLabs Scribe',
  apiKeyUrl: 'https://elevenlabs.io/app/settings/api-keys',
  configSchema: [
    {
      key: 'apiKey',
      type: 'secret',
      label: 'API Key',
      required: true,
      description: 'ElevenLabs API key (same as for TTS).',
    },
  ],
  capabilities: {
    supportsLanguageHint: true,
    supportsAutoDetectLanguage: true,
    // Scribe is one of the few providers that ships native speaker
    // diarization — distinguishes it from Whisper-family.
    supportsDiarization: true,
    supportsTimestamps: true,
    // No vocabulary biasing field (unlike Whisper's `prompt`). Audio-
    // event tagging is the closest analog and works automatically.
    supportsPromptBiasing: false,
    supportedAudioFormats: [
      'audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav',
      'audio/webm', 'audio/ogg', 'audio/flac',
      'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac',
    ],
    supportsStreaming: false,
  },

  async authenticate(config): Promise<AuthResult> {
    let apiKey: string
    try {
      apiKey = getApiKey(config)
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }

    // /v1/models is the universally-accessible probe (same as the TTS
    // provider). Workspace API keys with TTS+STT scope return 200 here.
    try {
      let response: Response
      try {
        response = await fetch(`${API_BASE}/models`, {
          method: 'GET',
          headers: { 'xi-api-key': apiKey, Accept: 'application/json' },
        })
      } catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : String(err) }
      }
      if (response.ok) return { valid: true }
      if (response.status === 401 || response.status === 403) {
        return { valid: false, error: `ElevenLabs authentication failed (HTTP ${response.status}).` }
      }
      const body = await response.text().catch(() => '')
      return { valid: false, error: `ElevenLabs /v1/models returned HTTP ${response.status}: ${body.slice(0, 200)}` }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) }
    }
  },

  async listModels(_config: ProviderConfig): Promise<TranscriptionModel[]> {
    // Hardcoded catalogue — /v1/models also returns TTS models and
    // there's no clean way to filter; safer to enumerate Scribe's two
    // variants explicitly.
    return KNOWN_MODELS
  },

  async transcribe(
    model: TranscriptionModel,
    request: TranscribeRequest,
    config: ProviderConfig,
  ): Promise<TranscribeResult> {
    const apiKey = getApiKey(config)
    const warnings: string[] = []

    const ext = extensionForMediaType(request.audio.mediaType)
    if (ext === 'bin') {
      warnings.push(
        `Audio MIME type "${request.audio.mediaType}" not recognized; ElevenLabs may reject it.`,
      )
    }

    const form = new FormData()
    const file = new File([request.audio.data as BlobPart], `audio.${ext}`, {
      type: request.audio.mediaType,
    })
    form.append('file', file)
    form.append('model_id', model.id)
    if (request.lang) form.append('language_code', request.lang)
    if (request.diarize) form.append('diarize', 'true')
    // Scribe's timestamps are at word granularity even when we don't
    // ask — we promote them to segment-level via `buildSegments()`
    // when the caller wants timestamps OR diarization (the second
    // mode needs them to know where to split speakers).
    if (request.timestamps || request.diarize) {
      form.append('timestamps_granularity', 'word')
    }

    // Provider-specific knobs ride through `extra`:
    //   - tag_audio_events (bool) — annotate [laughter], [music], …
    //   - num_speakers (int)     — diarization hint
    if (typeof request.extra?.['tag_audio_events'] === 'boolean') {
      form.append('tag_audio_events', String(request.extra['tag_audio_events']))
    }
    if (typeof request.extra?.['num_speakers'] === 'number') {
      form.append('num_speakers', String(request.extra['num_speakers']))
    }

    const data = await callScribe(form, apiKey, request.signal)

    const segments =
      (request.timestamps || request.diarize) && data.words
        ? buildSegments(data.words)
        : undefined

    return {
      text: data.text ?? '',
      ...(data.language_code ? { language: data.language_code } : {}),
      ...(segments && segments.length > 0 ? { segments } : {}),
      ...(warnings.length ? { warnings } : {}),
    }
  },
}
