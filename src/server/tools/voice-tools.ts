/**
 * Native voice tools exposed to Agents.
 *
 * Discovery:
 *  - `list_tts_providers` / `list_stt_providers` — configured providers
 *     for each family + their static capabilities + the current default.
 *  - `list_voices` — voice catalogue across one or every configured TTS
 *     provider (optionally filtered by language).
 *  - `list_stt_models` — transcription model catalogue across one or
 *     every configured STT provider.
 *
 * Action:
 *  - `text_to_speech` — synthesizes audio bytes, persists them in the
 *    messages-attachment file table (same path as generate_image), and
 *    returns the file_id + URL the Agent can attach to its reply.
 *  - `transcribe_audio` — reads bytes from an existing file_id, sends
 *    them to the resolved STT provider, returns the transcript.
 *
 * Slug-based provider resolution mirrors search (TTS / STT resolvers
 * land in services/{tts,stt}-resolver.ts).
 */

import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { v4 as uuid } from 'uuid'
import { join } from 'path'
import { mkdir } from 'fs/promises'
import { tool } from '@/server/tools/tool-helper'
import { db } from '@/server/db/index'
import { providers as providersTable, files } from '@/server/db/schema'
import { loadProviderConfig } from '@/server/services/provider-config'
import { getTTSProvider, listTTSProviders } from '@/server/llm/tts/registry'
import { getSTTProvider, listSTTProviders } from '@/server/llm/stt/registry'
import {
  getDefaultTtsProviderId,
  getDefaultSttProviderId,
} from '@/server/services/app-settings'
import {
  resolveTtsProvider,
  TTSResolveError,
} from '@/server/services/tts-resolver'
import {
  resolveSttProvider,
  STTResolveError,
} from '@/server/services/stt-resolver'
import type { SpeakRequest } from '@/server/llm/tts/types'
import type { TranscribeRequest } from '@/server/llm/stt/types'
import type { ProviderConfig } from '@/server/llm/core/types'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:voice')

// ─── list_tts_providers ──────────────────────────────────────────────────────

export const listTtsProvidersTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'List configured TTS providers with their capabilities (supportsAnswer-style ' +
        'flags: supportsStreaming, supportsSSML, supportsInstructions, supportsSpeedControl, ' +
        'supportsLanguageOverride, supportedFormats). The entry with `isDefault: true` is ' +
        'what `text_to_speech` uses when no `provider_slug` is passed. Call this before ' +
        '`list_voices` if you need a specific capability.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = db.select().from(providersTable).all()
        const defaultId = await getDefaultTtsProviderId()

        const items = rows
          .filter((p) => p.isValid)
          .filter((p) => {
            try {
              const caps = JSON.parse(p.capabilities) as string[]
              return caps.includes('tts')
            } catch {
              return false
            }
          })
          .map((p) => {
            const provider = getTTSProvider(p.type)
            return {
              slug: p.slug,
              displayName: provider?.displayName ?? p.name,
              isDefault: p.id === defaultId,
              capabilities: provider?.capabilities ?? {},
              ...(provider ? {} : { unavailable: true as const }),
            }
          })

        return { providers: items }
      },
    }),
}

// ─── list_voices ─────────────────────────────────────────────────────────────

export const listVoicesTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'List voices across configured TTS providers. Returns the voice catalogue ' +
        'each provider exposes (catalog is fetched live from the upstream — no ' +
        'host-side caching today). Pass `provider_slug` to scope to one provider. ' +
        'Pass `language` to filter by BCP 47 prefix (e.g. "fr" matches "fr-FR"). ' +
        'Use the `voice_id` from this output as input to `text_to_speech`.',
      inputSchema: z.object({
        provider_slug: z
          .string()
          .optional()
          .describe('Limit to a single provider. Omit to scan every configured TTS provider.'),
        language: z
          .string()
          .optional()
          .describe('BCP 47 prefix filter (e.g. "fr", "en-US"). Voices without a language tag are kept.'),
      }),
      execute: async ({ provider_slug, language }) => {
        type FlatVoice = {
          provider_slug: string
          voice_id: string
          name: string
          language?: string
          gender?: 'male' | 'female' | 'neutral'
          description?: string
          model?: string
          preview_url?: string
        }

        const out: FlatVoice[] = []
        const warnings: string[] = []

        // Build the candidate-provider list. Single-slug path = direct
        // resolver call; multi-slug path = scan every valid TTS row.
        let candidates: Array<{ slug: string; type: string; config: ProviderConfig }> = []
        if (provider_slug) {
          try {
            const resolved = await resolveTtsProvider(provider_slug)
            candidates = [{ slug: resolved.row.slug, type: resolved.row.type, config: resolved.config }]
          } catch (err) {
            if (err instanceof TTSResolveError) return { error: err.message, code: err.code }
            throw err
          }
        } else {
          const rows = db.select().from(providersTable).all()
          for (const p of rows) {
            if (!p.isValid) continue
            try {
              const caps = JSON.parse(p.capabilities) as string[]
              if (!caps.includes('tts')) continue
              if (!getTTSProvider(p.type)) continue  // plugin not loaded
              const cfg = await loadProviderConfig(p)
              candidates.push({ slug: p.slug, type: p.type, config: cfg })
            } catch {
              // Skip rows whose config can't be decrypted or capabilities parsed.
            }
          }
        }

        // Fetch each provider's catalogue in parallel; soft-fail per provider
        // so one bad upstream doesn't kill the whole listing.
        const langPrefix = language?.toLowerCase()
        await Promise.all(
          candidates.map(async (c) => {
            const provider = getTTSProvider(c.type)
            if (!provider) return
            try {
              const voices = await provider.listVoices(c.config)
              for (const v of voices) {
                if (langPrefix && v.language && !v.language.toLowerCase().startsWith(langPrefix)) {
                  continue
                }
                out.push({
                  provider_slug: c.slug,
                  voice_id: v.id,
                  name: v.name,
                  ...(v.language ? { language: v.language } : {}),
                  ...(v.gender ? { gender: v.gender } : {}),
                  ...(v.description ? { description: v.description } : {}),
                  ...(v.model ? { model: v.model } : {}),
                  ...(v.previewUrl ? { preview_url: v.previewUrl } : {}),
                })
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              warnings.push(`Failed to list voices for "${c.slug}": ${msg}`)
              log.warn({ provider: c.slug, err: msg }, 'list_voices upstream failed')
            }
          }),
        )

        return {
          voices: out,
          ...(warnings.length ? { warnings } : {}),
        }
      },
    }),
}

// ─── text_to_speech ──────────────────────────────────────────────────────────

export const textToSpeechTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  // Not readOnly: writes a file to disk + a row in `files`. Concurrency-safe:
  // each call produces its own file with a fresh UUID; no shared state.
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Synthesize speech audio from text. Returns a file_id + URL that can be ' +
        'attached to a reply (channel vocal message, file share, …). Voice is ' +
        'mandatory — call `list_voices` first if you don\'t know what is available. ' +
        'Pass `provider_slug` to override the global default; otherwise the ' +
        'configured default TTS provider is used (the voice_id encodes which ' +
        'model it binds to, so cross-provider mismatch is impossible).',
      inputSchema: z.object({
        text: z.string().min(1).describe('Text to synthesize. Plain text — no SSML.'),
        voice_id: z.string().min(1).describe('Voice identifier from list_voices.'),
        provider_slug: z
          .string()
          .optional()
          .describe('TTS provider slug. Omit to use the global default.'),
        format: z
          .enum(['mp3', 'wav', 'opus', 'pcm'])
          .optional()
          .describe('Output audio format. Provider clamps to what it supports (default: mp3).'),
        sample_rate: z
          .number()
          .int()
          .optional()
          .describe('Output sample rate in Hz (16000, 22050, 24000, 44100, …).'),
        speed: z
          .number()
          .optional()
          .describe('Playback rate multiplier. 1.0 = normal. Honored when supportsSpeedControl is true.'),
        lang: z
          .string()
          .optional()
          .describe('Language override for multilingual voices. Honored when supportsLanguageOverride is true.'),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Provider-specific knobs (ElevenLabs stability/similarity_boost, ' +
              'OpenAI gpt-4o-mini-tts instructions, …). Unknown keys are silently ignored.',
          ),
      }),
      execute: async (args) => {
        const {
          text,
          voice_id,
          provider_slug,
          format,
          sample_rate,
          speed,
          lang,
          extra,
        } = args

        let resolved
        try {
          resolved = await resolveTtsProvider(provider_slug)
        } catch (err) {
          if (err instanceof TTSResolveError) return { error: err.message, code: err.code }
          throw err
        }

        const { row, config: providerCfg, provider } = resolved

        // Resolve the voice by id from the provider's catalogue.
        let voice
        try {
          const voices = await provider.listVoices(providerCfg)
          voice = voices.find((v) => v.id === voice_id)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { error: `Failed to fetch voices from ${row.slug}: ${msg}`, code: 'VOICE_FETCH_FAILED' }
        }
        if (!voice) {
          return {
            error: `No voice with id "${voice_id}" on provider "${row.slug}". Call list_voices to see what's available.`,
            code: 'VOICE_NOT_FOUND',
          }
        }

        // Capability-mismatch warnings — same host-owns-the-contract
        // pattern as web_search. Provider also calls speak() with the
        // request as-is; warnings here are preemptive.
        const warnings: string[] = []
        const caps = provider.capabilities
        if (speed !== undefined && !caps.supportsSpeedControl) {
          warnings.push(`Provider "${row.slug}" does not support speed control — the speed argument will be ignored.`)
        }
        if (lang && !caps.supportsLanguageOverride) {
          warnings.push(`Provider "${row.slug}" does not support language override — the lang argument will be ignored.`)
        }
        if (
          format &&
          caps.supportedFormats &&
          caps.supportedFormats.length > 0 &&
          !caps.supportedFormats.includes(format)
        ) {
          warnings.push(
            `Provider "${row.slug}" does not support format "${format}" (supported: ${caps.supportedFormats.join(', ')}); the provider will downgrade and warn.`,
          )
        }

        const request: SpeakRequest = {
          text,
          ...(format ? { format } : {}),
          ...(sample_rate !== undefined ? { sampleRate: sample_rate } : {}),
          ...(speed !== undefined ? { speed } : {}),
          ...(lang !== undefined ? { lang } : {}),
          ...(extra !== undefined ? { extra } : {}),
        }

        log.debug(
          { providerSlug: row.slug, voiceId: voice_id, textLen: text.length, format },
          'text_to_speech invoked',
        )

        let result
        try {
          result = await provider.speak(voice, request, providerCfg)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn({ providerSlug: row.slug, voiceId: voice_id, error: msg }, 'text_to_speech failed')
          return { error: msg, provider: row.slug, voice_id }
        }

        // Persist the audio as a message attachment — same path as
        // generate_image (files table + /api/uploads/messages/<agentId>/...).
        const ext = extensionForMediaType(result.mediaType)
        const fileId = uuid()
        const storedName = `${fileId}-tts.${ext}`
        const dir = join(config.upload.dir, 'messages', ctx.agentId)
        const storedPath = join(dir, storedName)

        await mkdir(dir, { recursive: true })
        await Bun.write(storedPath, result.audio)

        await db.insert(files).values({
          id: fileId,
          agentId: ctx.agentId,
          sessionId: ctx.sessionId ?? null,
          originalName: storedName,
          storedPath,
          mimeType: result.mediaType,
          size: result.audio.byteLength,
          createdAt: new Date(),
        })

        const url = `/api/uploads/messages/${ctx.agentId}/${storedName}`

        const allWarnings = [...new Set([...warnings, ...(result.warnings ?? [])])]

        return {
          provider: row.slug,
          voice_id,
          file_id: fileId,
          url,
          media_type: result.mediaType,
          size: result.audio.byteLength,
          ...(result.durationMs !== undefined ? { duration_ms: result.durationMs } : {}),
          ...(allWarnings.length ? { warnings: allWarnings } : {}),
        }
      },
    }),
}

// ─── list_stt_providers ──────────────────────────────────────────────────────

export const listSttProvidersTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'List configured STT (speech-to-text) providers with their capabilities ' +
        '(supportsLanguageHint, supportsAutoDetectLanguage, supportsDiarization, ' +
        'supportsTimestamps, supportsPromptBiasing, supportedAudioFormats). The ' +
        'entry with `isDefault: true` is what `transcribe_audio` uses when no ' +
        '`provider_slug` is passed.',
      inputSchema: z.object({}),
      execute: async () => {
        const rows = db.select().from(providersTable).all()
        const defaultId = await getDefaultSttProviderId()

        const items = rows
          .filter((p) => p.isValid)
          .filter((p) => {
            try {
              const caps = JSON.parse(p.capabilities) as string[]
              return caps.includes('stt')
            } catch {
              return false
            }
          })
          .map((p) => {
            const provider = getSTTProvider(p.type)
            return {
              slug: p.slug,
              displayName: provider?.displayName ?? p.name,
              isDefault: p.id === defaultId,
              capabilities: provider?.capabilities ?? {},
              ...(provider ? {} : { unavailable: true as const }),
            }
          })

        return { providers: items }
      },
    }),
}

// ─── list_stt_models ─────────────────────────────────────────────────────────

export const listSttModelsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'List transcription models exposed by configured STT providers. Pass ' +
        '`provider_slug` to limit to one provider; omit to scan every configured ' +
        'STT provider. Use the `model_id` from this output as optional input to ' +
        '`transcribe_audio` (when omitted, the provider picks its default model).',
      inputSchema: z.object({
        provider_slug: z
          .string()
          .optional()
          .describe('Limit to a single STT provider. Omit to scan every configured STT provider.'),
      }),
      execute: async ({ provider_slug }) => {
        type FlatModel = {
          provider_slug: string
          model_id: string
          name: string
          supported_languages?: string[]
          max_audio_seconds?: number
        }

        const out: FlatModel[] = []
        const warnings: string[] = []

        let candidates: Array<{ slug: string; type: string; config: ProviderConfig }> = []
        if (provider_slug) {
          try {
            const resolved = await resolveSttProvider(provider_slug)
            candidates = [{ slug: resolved.row.slug, type: resolved.row.type, config: resolved.config }]
          } catch (err) {
            if (err instanceof STTResolveError) return { error: err.message, code: err.code }
            throw err
          }
        } else {
          const rows = db.select().from(providersTable).all()
          for (const p of rows) {
            if (!p.isValid) continue
            try {
              const caps = JSON.parse(p.capabilities) as string[]
              if (!caps.includes('stt')) continue
              if (!getSTTProvider(p.type)) continue
              const cfg = await loadProviderConfig(p)
              candidates.push({ slug: p.slug, type: p.type, config: cfg })
            } catch {
              // Skip unreadable rows.
            }
          }
        }

        await Promise.all(
          candidates.map(async (c) => {
            const provider = getSTTProvider(c.type)
            if (!provider) return
            try {
              const models = await provider.listModels(c.config)
              for (const m of models) {
                out.push({
                  provider_slug: c.slug,
                  model_id: m.id,
                  name: m.name,
                  ...(m.supportedLanguages ? { supported_languages: m.supportedLanguages } : {}),
                  ...(m.maxAudioSeconds ? { max_audio_seconds: m.maxAudioSeconds } : {}),
                })
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              warnings.push(`Failed to list models for "${c.slug}": ${msg}`)
              log.warn({ provider: c.slug, err: msg }, 'list_stt_models upstream failed')
            }
          }),
        )

        return {
          models: out,
          ...(warnings.length ? { warnings } : {}),
        }
      },
    }),
}

// ─── transcribe_audio ────────────────────────────────────────────────────────

export const transcribeAudioTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Transcribe an audio file to text. The file must already exist in storage — ' +
        'pass its `file_id` (audio attachments from channels, user uploads, or ' +
        'previous `text_to_speech` calls all qualify). Pass `provider_slug` to ' +
        'override the global default. `model_id` is optional: omit for the ' +
        'provider\'s default transcription model, set it to pick a specific one ' +
        '(call `list_stt_models` to discover available ids).',
      inputSchema: z.object({
        file_id: z.string().min(1).describe('File id of the audio to transcribe.'),
        provider_slug: z
          .string()
          .optional()
          .describe('STT provider slug. Omit to use the global default.'),
        model_id: z
          .string()
          .optional()
          .describe('Specific transcription model. Omit for the provider default.'),
        lang: z
          .string()
          .optional()
          .describe('ISO 639-1 language hint. Honored when supportsLanguageHint is true.'),
        prompt: z
          .string()
          .optional()
          .describe('Vocabulary biasing prompt (Whisper-style). Honored when supportsPromptBiasing is true.'),
        diarize: z
          .boolean()
          .optional()
          .describe('Request per-segment speaker labels. Honored when supportsDiarization is true.'),
        timestamps: z
          .boolean()
          .optional()
          .describe('Request per-segment start/end timestamps. Honored when supportsTimestamps is true.'),
        extra: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Provider-specific options. Unknown keys are silently ignored.'),
      }),
      execute: async (args) => {
        const { file_id, provider_slug, model_id, lang, prompt, diarize, timestamps, extra } = args

        // Look up the audio file. Direct DB read because the public
        // download helper increments counters / honors read-and-burn,
        // both inappropriate for internal tool use.
        const fileRow = await db.select().from(files).where(eq(files.id, file_id)).get()
        if (!fileRow) {
          return { error: `No file with id "${file_id}".`, code: 'FILE_NOT_FOUND' }
        }
        if (fileRow.agentId !== ctx.agentId) {
          // Agent isolation — never let an Agent transcribe another Agent's audio.
          return { error: 'File belongs to another Agent.', code: 'FILE_FORBIDDEN' }
        }

        // Resolve provider.
        let resolved
        try {
          resolved = await resolveSttProvider(provider_slug)
        } catch (err) {
          if (err instanceof STTResolveError) return { error: err.message, code: err.code }
          throw err
        }
        const { row, config: providerCfg, provider } = resolved

        // Resolve model: explicit id wins, otherwise first from listModels().
        let model
        try {
          const models = await provider.listModels(providerCfg)
          if (model_id) {
            model = models.find((m) => m.id === model_id)
            if (!model) {
              return {
                error: `No model with id "${model_id}" on provider "${row.slug}". Call list_stt_models to see what's available.`,
                code: 'MODEL_NOT_FOUND',
              }
            }
          } else {
            model = models[0]
            if (!model) {
              return {
                error: `Provider "${row.slug}" exposes no transcription models.`,
                code: 'NO_MODELS_AVAILABLE',
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { error: `Failed to fetch models from ${row.slug}: ${msg}`, code: 'MODEL_FETCH_FAILED' }
        }

        // Pre-flight capability warnings.
        const warnings: string[] = []
        const caps = provider.capabilities
        if (lang && !caps.supportsLanguageHint) {
          warnings.push(`Provider "${row.slug}" does not honor language hints — lang will be ignored.`)
        }
        if (prompt && !caps.supportsPromptBiasing) {
          warnings.push(`Provider "${row.slug}" does not support prompt biasing — prompt will be ignored.`)
        }
        if (diarize && !caps.supportsDiarization) {
          warnings.push(`Provider "${row.slug}" does not support diarization — diarize will be ignored.`)
        }
        if (timestamps && !caps.supportsTimestamps) {
          warnings.push(`Provider "${row.slug}" does not support timestamps — timestamps will be ignored.`)
        }

        // Load bytes from disk.
        let audioBytes: Uint8Array
        try {
          const buf = await Bun.file(fileRow.storedPath).arrayBuffer()
          audioBytes = new Uint8Array(buf)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { error: `Failed to read audio bytes: ${msg}`, code: 'FILE_READ_FAILED' }
        }

        const request: TranscribeRequest = {
          audio: { data: audioBytes, mediaType: fileRow.mimeType },
          ...(lang ? { lang } : {}),
          ...(prompt ? { prompt } : {}),
          ...(diarize !== undefined ? { diarize } : {}),
          ...(timestamps !== undefined ? { timestamps } : {}),
          ...(extra ? { extra } : {}),
        }

        log.debug(
          { providerSlug: row.slug, modelId: model.id, fileId: file_id, mimeType: fileRow.mimeType, size: fileRow.size },
          'transcribe_audio invoked',
        )

        let result
        try {
          result = await provider.transcribe(model, request, providerCfg)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          log.warn({ providerSlug: row.slug, modelId: model.id, error: msg }, 'transcribe_audio failed')
          return { error: msg, provider: row.slug, model_id: model.id }
        }

        const allWarnings = [...new Set([...warnings, ...(result.warnings ?? [])])]

        return {
          provider: row.slug,
          model_id: model.id,
          text: result.text,
          ...(result.language ? { language: result.language } : {}),
          ...(result.durationMs !== undefined ? { duration_ms: result.durationMs } : {}),
          ...(result.segments ? { segments: result.segments } : {}),
          ...(allWarnings.length ? { warnings: allWarnings } : {}),
        }
      },
    }),
}

// Internal — defensive against unknown ID lists (not currently exposed but
// referenced from the registry import path so it tree-shakes cleanly).
void listTTSProviders
void listSTTProviders

// ─── helpers ─────────────────────────────────────────────────────────────────

function extensionForMediaType(mediaType: string): string {
  switch (mediaType.toLowerCase()) {
    case 'audio/mpeg':
    case 'audio/mp3':  return 'mp3'
    case 'audio/wav':
    case 'audio/x-wav': return 'wav'
    case 'audio/ogg':  return 'ogg'
    case 'audio/pcm':  return 'pcm'
    case 'audio/flac': return 'flac'
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a': return 'm4a'
    case 'audio/webm': return 'webm'
    case 'audio/aac':  return 'aac'
    default: return 'bin'
  }
}
