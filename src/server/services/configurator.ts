/**
 * Configurator Kin (Sherpa) seeding — creates the user's first Kin, the
 * conversational onboarding guide. Idempotent: only one configurator Kin ever
 * exists. See sherpa.md.
 */

import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { kins, providers } from '@/server/db/schema'
import { createKin } from '@/server/services/kins'
import { getToolboxByName } from '@/server/services/toolboxes'
import { loadProviderConfig } from '@/server/services/provider-config'
import { listModelsForProvider } from '@/server/providers/index'
import { enqueueMessage } from '@/server/services/queue'
import { CONFIGURATOR_MODEL_PREFERENCES } from '@/shared/constants'
import { config } from '@/server/config'
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'

const log = createLogger('configurator')

const SHERPA = {
  name: 'Sherpa',
  role: 'Your KinBot onboarding & configuration guide',
  character:
    'You are Sherpa: warm, patient, and genuinely helpful — a friendly guide, never condescending. You explain things simply, in plain language, one step at a time, and you celebrate small wins. You are honest and transparent: you tell people what you need and why, and you never pretend something works until you have actually tested it.',
  expertise:
    "You are the user's onboarding guide and permanent configuration assistant. You know KinBot inside out and you set the platform up through conversation — connecting AI providers, wiring up memory, avatars, channels, and helping the user create their first Kins — so they never have to dig through menus.",
}

/** The single configurator Kin, or undefined if not seeded yet. */
export function getConfiguratorKin() {
  return db.select().from(kins).where(eq(kins.kind, 'configurator')).get()
}

/**
 * Pick a balanced, tool-use-reliable model for Sherpa from the bootstrap
 * provider's live catalogue (preference list → first available). Drift-proof.
 */
async function resolveConfiguratorModel(providerId: string): Promise<string> {
  const provider = db.select().from(providers).where(eq(providers.id, providerId)).get()
  if (!provider) throw new Error(`Provider not found: ${providerId}`)
  const cfg = await loadProviderConfig(provider)
  const models = await listModelsForProvider(provider.type, cfg, 'llm')
  const ids = models.filter((m) => m.capability === 'llm').map((m) => m.id)
  if (ids.length === 0) throw new Error(`Provider "${provider.type}" exposes no LLM models to seed the configurator with`)
  const prefs = CONFIGURATOR_MODEL_PREFERENCES[provider.type] ?? []
  for (const pref of prefs) {
    const match = ids.find((id) => id.toLowerCase().includes(pref.toLowerCase()))
    if (match) return match
  }
  return ids[0]!
}

/**
 * Seed the configurator Kin bound to the just-added bootstrap LLM provider.
 * Idempotent — returns the existing one if already seeded (no duplicate, no
 * second kickoff).
 */
export async function seedConfiguratorKin(adminUserId: string, providerId: string) {
  const existing = getConfiguratorKin()
  if (existing) return existing

  const model = await resolveConfiguratorModel(providerId)
  const toolbox = getToolboxByName('configurator')
  if (!toolbox) log.warn('configurator toolbox not found — Sherpa will fall back to the full toolset')

  // Make the bootstrap provider the default LLM (model + provider) if the user
  // hasn't set one yet — so the Kins they create next inherit a working default.
  const { getDefaultLlmProviderId, setDefaultLlmModel, setDefaultLlmProviderId } = await import('@/server/services/app-settings')
  if (!(await getDefaultLlmProviderId())) {
    await setDefaultLlmModel(model)
    await setDefaultLlmProviderId(providerId)
  }

  const kin = await createKin({
    name: SHERPA.name,
    role: SHERPA.role,
    character: SHERPA.character,
    expertise: SHERPA.expertise,
    model,
    providerId,
    kind: 'configurator',
    createdBy: adminUserId,
    toolboxIds: toolbox ? [toolbox.id] : null,
  })

  // Assign the bundled avatar (no image provider exists yet, so it is not
  // generated). The asset may ship as png/jpg/webp — match the real extension
  // so it's served with the correct content type.
  try {
    const assetsDir = join(import.meta.dir, '..', 'assets')
    let srcPath: string | null = null
    let ext = 'png'
    for (const e of ['png', 'jpg', 'jpeg', 'webp']) {
      const p = join(assetsDir, `sherpa-avatar.${e}`)
      if (existsSync(p)) { srcPath = p; ext = e === 'jpeg' ? 'jpg' : e; break }
    }
    if (srcPath) {
      const dir = `${config.upload.dir}/kins/${kin.id}`
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const dest = `${dir}/avatar.${ext}`
      await Bun.write(dest, Bun.file(srcPath))
      await db.update(kins).set({ avatarPath: dest, updatedAt: new Date() }).where(eq(kins.id, kin.id))
      sseManager.broadcast({
        type: 'kin:updated',
        kinId: kin.id,
        data: { kinId: kin.id, avatarUrl: `/api/uploads/kins/${kin.id}/avatar.${ext}?v=${Date.now()}` },
      })
    }
  } catch (err) {
    log.warn({ kinId: kin.id, err }, 'Failed to assign bundled Sherpa avatar')
  }

  // Kickoff: a hidden system trigger so Sherpa greets the user first (no user
  // message needed). sourceType 'system' keeps it out of the normal user bubbles.
  await enqueueMessage({
    kinId: kin.id,
    messageType: 'user',
    content:
      '[A new user just finished initial setup and opened the onboarding chat. Greet them warmly, introduce yourself as their KinBot guide, and start onboarding by getting to know them. Keep it short and friendly.]',
    sourceType: 'system',
    priority: config.queue.userPriority,
  })

  log.info({ kinId: kin.id, model }, 'Configurator Kin (Sherpa) seeded')
  return db.select().from(kins).where(eq(kins.id, kin.id)).get()
}
