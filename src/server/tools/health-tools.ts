/**
 * Health / diagnostic tools — the "doctor 2.0" read-only rescue tool for the
 * configurator Agent (Queenie).
 *
 * `get_setup_health` returns a single structured snapshot of the platform's
 * FUNCTIONAL health (is there a valid LLM provider? a default embedding model?
 * a working search provider? do the configured default models still exist in
 * their provider's live catalogue? are channels active? does the public URL
 * match the access origin?) plus a PRIORITIZED list of issues, each carrying the
 * exact fix tool/action that resolves it.
 *
 * It is strictly READ-ONLY: it never mutates providers, defaults, or channels —
 * it only diagnoses. The fixes it points at (request_provider_setup / test_provider
 * / set_default_model / set_default_provider / enable_provider_capability /
 * test_channel / update_platform_config) live in the other configurator tools.
 *
 * It does NOT require admin: reading health is harmless. (The fix tools it
 * references are themselves admin-guarded.)
 */

import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { db } from '@/server/db/index'
import { providers, channels } from '@/server/db/schema'
import { listModelsForProvider } from '@/server/providers/index'
import { loadProviderConfig } from '@/server/services/provider-config'
import {
  getDefaultLlmModel, getDefaultLlmProviderId,
  getEmbeddingModel, getEmbeddingProviderId,
  getDefaultImageModel, getDefaultImageProviderId,
  getDefaultScoutModel, getDefaultScoutProviderId,
  getDefaultCompactingModel, getDefaultCompactingProviderId,
  getExtractionModel, getExtractionProviderId,
  getDefaultSearchProviderId, getDefaultTtsProviderId, getDefaultSttProviderId,
} from '@/server/services/app-settings'
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:health')

// ─── Types ─────────────────────────────────────────────────────────────────────

/** Capabilities that can be covered by a provider. */
type Capability = 'llm' | 'embedding' | 'image' | 'search' | 'tts' | 'stt'
const CAPABILITIES: readonly Capability[] = ['llm', 'embedding', 'image', 'search', 'tts', 'stt']

/** Model-bearing default services (default = model + provider pair). */
type ModelService = 'llm' | 'embedding' | 'image' | 'scout' | 'compacting' | 'extraction'

/** The model families we can list from a provider (the only ones with a catalogue). */
type ModelFamily = 'llm' | 'embedding' | 'image'

type Severity = 'critical' | 'warning' | 'info'
const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2 }

interface HealthIssue {
  severity: Severity
  /** What is broken / missing, in plain language. */
  problem: string
  /** The exact tool/action that resolves it. */
  fix: string
}

interface ProviderRow {
  id: string
  slug: string
  name: string
  type: string
  isValid: boolean
  lastError: string | null
  capabilities: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseCapabilities(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
  } catch {
    /* ignore */
  }
  return []
}

/**
 * Compare the configured public URL origin to the access origin we *know about*.
 * The browser-side check (getPublicUrlMismatch) compares against
 * window.location.origin; server-side we have no window, so we instead flag the
 * most actionable footgun: PUBLIC_URL is still left at a localhost default while
 * the platform is clearly meant to be reachable (a real deployment). We surface
 * the configured value either way so Queenie can ask the user how they reach it.
 */
function describePublicUrl(): {
  publicUrl: string
  isLocalhostDefault: boolean
  installationType: string
  isDocker: boolean
} {
  const publicUrl = config.publicUrl
  let origin = publicUrl
  try {
    origin = new URL(publicUrl).origin
  } catch {
    /* leave as-is */
  }
  const isLocalhostDefault = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
  return {
    publicUrl,
    isLocalhostDefault,
    installationType: config.environment.installationType,
    isDocker: config.isDocker,
  }
}

// ─── get_setup_health ──────────────────────────────────────────────────────────

export const getSetupHealthTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: (_ctx) =>
    tool({
      description:
        'Run a full read-only HEALTH CHECK of the Hivekeep platform and get a prioritized rescue plan. ' +
        'CALL THIS FIRST whenever a user reports that something is broken, not working, or "I set it up but nothing happens", and at the start of any rescue / re-configuration. ' +
        'It returns: capability coverage for llm / embedding / image / search / tts / stt (does a VALID provider exist? is a default set?); ' +
        'every INVALID provider with its `lastError` (usually a bad/expired API key); ' +
        'STALE defaults — a configured default model/provider that no longer exists in its provider\'s live catalogue (or points at a missing/invalid provider); ' +
        'channel statuses (active/inactive/error with the last error); a public-URL / access-origin sanity check; ' +
        'and an `issues` array, sorted by severity, where each issue names the EXACT fix tool to call ' +
        '(e.g. request_provider_setup / test_provider for a bad key, set_default_model for a stale or missing default, ' +
        'enable_provider_capability + set_default_provider for a missing capability, test_channel for an inactive channel, ' +
        'update_platform_config for a wrong PUBLIC_URL). This tool only DIAGNOSES — apply the fixes with those tools.',
      inputSchema: z.object({}),
      execute: async () => {
        const issues: HealthIssue[] = []

        // ─── 1. Load providers ────────────────────────────────────────────────
        const rows = await db.select().from(providers).all()
        const allProviders: ProviderRow[] = rows.map((p) => ({
          id: p.id,
          slug: p.slug,
          name: p.name,
          type: p.type,
          isValid: p.isValid,
          lastError: p.lastError ?? null,
          capabilities: parseCapabilities(p.capabilities),
        }))
        const providerById = new Map<string, ProviderRow>(allProviders.map((p) => [p.id, p]))

        const invalidProviders = allProviders
          .filter((p) => !p.isValid)
          .map((p) => ({ id: p.id, slug: p.slug, name: p.name, type: p.type, lastError: p.lastError }))

        // A bad/expired key is the single most common rescue scenario — flag each
        // invalid provider explicitly with the re-key/re-test fix.
        for (const p of invalidProviders) {
          issues.push({
            severity: 'critical',
            problem: `Provider "${p.name}" (${p.slug}) is configured but FAILING${p.lastError ? `: ${p.lastError}` : ' (no error recorded)'}. Until fixed it yields no usable models.`,
            fix: `Re-enter the API key with request_provider_setup (type "${p.type}"), then test_provider("${p.slug}") to re-validate. If the key is correct, the endpoint may be unreachable.`,
          })
        }

        // ─── 2. Live model catalogues (per valid provider, per model family) ──
        // Cache one listing per (providerId, family) so stale-default detection
        // and capability coverage don't re-hit the provider API.
        const catalogueCache = new Map<string, Set<string>>()
        async function listProviderModels(p: ProviderRow, family: ModelFamily): Promise<Set<string>> {
          const key = `${p.id}:${family}`
          const cached = catalogueCache.get(key)
          if (cached) return cached
          let ids = new Set<string>()
          if (p.isValid && p.capabilities.includes(family)) {
            try {
              const cfg = await loadProviderConfig(rows.find((r) => r.id === p.id)!)
              const models = await listModelsForProvider(p.type, cfg, family)
              ids = new Set(models.map((m) => m.id))
            } catch (err) {
              log.error({ providerId: p.id, family, err }, 'Failed to list models for health check')
            }
          }
          catalogueCache.set(key, ids)
          return ids
        }

        // ─── 3. Capability coverage ──────────────────────────────────────────
        // A capability is "covered" when at least one VALID provider declares it.
        const defaultProviderIds: Record<Capability, string | null> = {
          llm: await getDefaultLlmProviderId(),
          embedding: await getEmbeddingProviderId(),
          image: await getDefaultImageProviderId(),
          search: await getDefaultSearchProviderId(),
          tts: await getDefaultTtsProviderId(),
          stt: await getDefaultSttProviderId(),
        }

        const coverage: Record<Capability, {
          hasValidProvider: boolean
          validProviders: string[]
          defaultProviderId: string | null
          defaultProviderValid: boolean | null
        }> = {} as never

        for (const cap of CAPABILITIES) {
          const valid = allProviders.filter((p) => p.isValid && p.capabilities.includes(cap))
          const defProvId = defaultProviderIds[cap]
          const defProv = defProvId ? providerById.get(defProvId) ?? null : null
          coverage[cap] = {
            hasValidProvider: valid.length > 0,
            validProviders: valid.map((p) => p.slug),
            defaultProviderId: defProvId,
            defaultProviderValid: defProv ? defProv.isValid : null,
          }

          // A configured default pointing at a missing provider is stale.
          if (defProvId && !defProv) {
            issues.push({
              severity: cap === 'llm' ? 'critical' : 'warning',
              problem: `The default ${cap} provider points at a provider that no longer exists (id ${defProvId}).`,
              fix: `Pick a current provider: set_default_provider(capability:"${cap}", provider_id:<slug>) (or set_default_model for model-bearing services). Use list_providers to see what's available.`,
            })
          } else if (defProv && !defProv.isValid) {
            issues.push({
              severity: cap === 'llm' ? 'critical' : 'warning',
              problem: `The default ${cap} provider "${defProv.name}" is currently FAILING${defProv.lastError ? `: ${defProv.lastError}` : ''}.`,
              fix: `Fix it (re-key with request_provider_setup then test_provider("${defProv.slug}")) or switch the default to a working provider with set_default_provider(capability:"${cap}", provider_id:<slug>).`,
            })
          }
        }

        // Missing LLM is fatal (the assistant cannot think without it).
        if (!coverage.llm.hasValidProvider) {
          issues.push({
            severity: 'critical',
            problem: 'No VALID LLM provider is configured — Agents cannot generate replies.',
            fix: 'Connect one with request_provider_setup (e.g. type "openai" / "anthropic" / "gemini"), or re-key the failing one and test_provider.',
          })
        }
        // Missing embedding degrades memory to keyword-only — important but not fatal.
        if (!coverage.embedding.hasValidProvider) {
          issues.push({
            severity: 'warning',
            problem: 'No VALID embedding provider — long-term memory falls back to keyword-only search (no semantic recall).',
            fix: 'Add/enable an embedding-capable provider (OpenAI is the common one). If you already have an OpenAI LLM provider, enable_provider_capability(provider_id:<slug>, capability:"embedding") reuses the same key, then set_default_model(service:"embedding", …).',
          })
        }
        // Optional capabilities — informational nudges only.
        if (!coverage.search.hasValidProvider) {
          issues.push({
            severity: 'info',
            problem: 'No search provider — Agents cannot do live web search.',
            fix: 'Add one with request_provider_setup (e.g. "brave-search", "tavily", "serpapi", "perplexity"), then set_default_provider(capability:"search", …).',
          })
        }
        if (!coverage.image.hasValidProvider) {
          issues.push({
            severity: 'info',
            problem: 'No image provider — generated avatars and images are unavailable.',
            fix: 'Add an image-capable provider (OpenAI, Gemini, or OpenAI-compatible with an Images API), or enable_provider_capability on an existing one, then set_default_model(service:"image", …).',
          })
        }
        if (!coverage.tts.hasValidProvider) {
          issues.push({
            severity: 'info',
            problem: 'No TTS (text-to-speech) provider — voice output is unavailable.',
            fix: 'Add a TTS-capable provider with request_provider_setup, then set_default_provider(capability:"tts", …).',
          })
        }
        if (!coverage.stt.hasValidProvider) {
          issues.push({
            severity: 'info',
            problem: 'No STT (speech-to-text) provider — voice transcription is unavailable.',
            fix: 'Add an STT-capable provider with request_provider_setup, then set_default_provider(capability:"stt", …).',
          })
        }

        // ─── 4. Stale default MODELS (model no longer in provider catalogue) ──
        // For each model-bearing service, if a default model is set AND we can
        // resolve a valid provider with a catalogue, check the model still exists.
        const modelDefaults: Record<ModelService, { model: string | null; providerId: string | null; family: ModelFamily }> = {
          llm: { model: await getDefaultLlmModel(), providerId: await getDefaultLlmProviderId(), family: 'llm' },
          embedding: { model: await getEmbeddingModel(), providerId: await getEmbeddingProviderId(), family: 'embedding' },
          image: { model: await getDefaultImageModel(), providerId: await getDefaultImageProviderId(), family: 'image' },
          scout: { model: await getDefaultScoutModel(), providerId: await getDefaultScoutProviderId(), family: 'llm' },
          compacting: { model: await getDefaultCompactingModel(), providerId: await getDefaultCompactingProviderId(), family: 'llm' },
          extraction: { model: await getExtractionModel(), providerId: await getExtractionProviderId(), family: 'llm' },
        }

        const defaultModels: Record<string, {
          model: string | null
          providerId: string | null
          providerSlug: string | null
          status: 'ok' | 'stale' | 'unknown' | 'unset' | 'no-provider'
        }> = {}

        for (const [service, d] of Object.entries(modelDefaults) as Array<[ModelService, typeof modelDefaults[ModelService]]>) {
          const prov = d.providerId ? providerById.get(d.providerId) ?? null : null
          let status: 'ok' | 'stale' | 'unknown' | 'unset' | 'no-provider' = 'unset'

          if (!d.model) {
            status = 'unset'
          } else if (!d.providerId) {
            // Model set without a pinned provider — we can't reliably verify it.
            status = 'unknown'
          } else if (!prov) {
            status = 'no-provider'
            issues.push({
              severity: service === 'llm' ? 'critical' : 'warning',
              problem: `Default ${service} model "${d.model}" is pinned to a provider that no longer exists (id ${d.providerId}).`,
              fix: `Re-point it with set_default_model(service:"${service}", model:<id>, provider_id:<slug>). Use list_models to find a current model + provider.`,
            })
          } else if (!prov.isValid) {
            // The provider error is already reported above; mark unknown so we
            // don't double-flag, but still note the model can't be served.
            status = 'unknown'
          } else {
            const catalogue = await listProviderModels(prov, d.family)
            if (catalogue.size === 0) {
              // Couldn't list (transient / provider doesn't expose a catalogue) —
              // don't cry wolf.
              status = 'unknown'
            } else if (catalogue.has(d.model)) {
              status = 'ok'
            } else {
              status = 'stale'
              issues.push({
                severity: service === 'llm' ? 'critical' : 'warning',
                problem: `Default ${service} model "${d.model}" is NO LONGER listed by its provider "${prov.name}" (${prov.slug}) — it was likely deprecated or renamed. Using it will fail at runtime.`,
                fix: `Pick a current model: set_default_model(service:"${service}", model:<id>, provider_id:"${prov.slug}"). Run list_models${d.family !== 'llm' ? `(capability:"${d.family}")` : ''} to see what "${prov.slug}" offers now.`,
              })
            }
          }

          defaultModels[service] = {
            model: d.model,
            providerId: d.providerId,
            providerSlug: prov?.slug ?? null,
            status,
          }
        }

        // ─── 5. Channels ──────────────────────────────────────────────────────
        const channelRows = await db.select().from(channels).all()
        const channelStatuses = channelRows.map((c) => ({
          id: c.id,
          name: c.name,
          platform: c.platform,
          status: c.status, // 'active' | 'inactive' | 'error'
          statusMessage: c.statusMessage ?? null,
        }))
        for (const c of channelStatuses) {
          if (c.status !== 'active') {
            issues.push({
              severity: c.status === 'error' ? 'warning' : 'info',
              problem: `Channel "${c.name}" (${c.platform}) is ${c.status}${c.statusMessage ? `: ${c.statusMessage}` : ''} — messages will not flow until it reconnects.`,
              fix: `Run test_channel(channel_id:"${c.id}") to re-activate and report the connection result. If it fails, the bot token may be wrong — re-run request_channel_setup.`,
            })
          }
        }

        // ─── 6. Public URL / access-origin sanity ────────────────────────────
        const publicUrlInfo = describePublicUrl()
        // A localhost PUBLIC_URL is only a real problem when the install is
        // typically reached from another device (docker / systemd-system): then
        // invitation/webhook/OAuth links and the CORS allowlist point at the
        // wrong host. A systemd-user (single-machine) or manual install legitimately
        // runs on localhost, so don't cry wolf there: surface a gentle, conditional
        // heads-up at most. The browser-side warning still catches a live origin mismatch.
        if (publicUrlInfo.isLocalhostDefault && publicUrlInfo.installationType !== 'manual') {
          const isRemoteByDefault =
            publicUrlInfo.installationType === 'docker' || publicUrlInfo.installationType === 'systemd-system'
          issues.push({
            severity: isRemoteByDefault ? 'warning' : 'info',
            problem: isRemoteByDefault
              ? `PUBLIC_URL is still "${publicUrlInfo.publicUrl}" (a localhost default) on a ${publicUrlInfo.installationType} install. Invitation links, channel webhooks, OAuth callbacks and the CORS allowlist all derive from PUBLIC_URL, so they will point at the wrong host when accessed remotely.`
              : `PUBLIC_URL is "${publicUrlInfo.publicUrl}" (a localhost default). That's fine if you only ever open Hivekeep on this machine. If you access it from another device (phone, another computer) or use invitation links, channel webhooks or OAuth callbacks, set PUBLIC_URL to the address you actually reach it at.`,
            fix: publicUrlInfo.isDocker
              ? 'Set PUBLIC_URL to the URL users actually reach (e.g. https://hivekeep.example.com) via the Docker -e PUBLIC_URL / compose env, then recreate the container. (update_platform_config returns Docker guidance.)'
              : 'If you reach Hivekeep from another device, set PUBLIC_URL to that address via update_platform_config(key:"PUBLIC_URL", value:"https://your-host"), then restart. Ask the user what address they open Hivekeep at; if it really is only ever this machine, leave it as is.',
          })
        }

        // ─── 7. Sort + summarize ─────────────────────────────────────────────
        issues.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
        const counts = {
          critical: issues.filter((i) => i.severity === 'critical').length,
          warning: issues.filter((i) => i.severity === 'warning').length,
          info: issues.filter((i) => i.severity === 'info').length,
        }
        const healthy = counts.critical === 0 && counts.warning === 0

        return {
          healthy,
          summary: healthy
            ? 'No problems detected. Core capabilities have a valid provider and defaults look current.'
            : `${counts.critical} critical, ${counts.warning} warning, ${counts.info} info. Address criticals first (each issue lists the exact fix tool).`,
          counts,
          capabilityCoverage: coverage,
          defaultModels,
          invalidProviders,
          channels: channelStatuses,
          publicUrl: publicUrlInfo,
          issues,
        }
      },
    }),
}
