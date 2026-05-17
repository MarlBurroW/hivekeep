/**
 * One-shot boot pass that splits every multi-capability provider row in the
 * `providers` table into one row per family.
 *
 * Context: until Phase C2 a single provider row (e.g. OpenAI with `apiKey`)
 * carried `capabilities: ['llm', 'embedding', 'image']`. The new model is
 * "one row = one family" — the dispatcher in src/server/llm/ now routes
 * `provider.chat()` / `provider.embed()` / `provider.generate()` through
 * three separate registries, and each row needs to advertise exactly one
 * family so the UI can enable/disable them independently and a future
 * Replicate or Voyage provider drops in cleanly.
 *
 * Strategy:
 *   - Scan every row whose `capabilities` JSON array contains more than
 *     one entry.
 *   - Keep the original row, narrow its `capabilities` to the primary
 *     family (preferring 'llm' → 'embedding' → 'image'), and set
 *     `family` accordingly. Slug stays the same so Kins that memorised
 *     the LLM slug ("openai") don't break.
 *   - For each other family, insert a new row with a fresh UUID, the
 *     same encrypted config (so the user doesn't have to re-enter the
 *     API key), a derived name ("OpenAI" → "OpenAI (Embedding)"), and
 *     a derived slug ("openai" → "openai-embedding").
 *
 * Idempotent: a row that already has `capabilities.length === 1` is left
 * untouched, so re-running the service on subsequent boots is a no-op.
 */
import { v4 as uuid } from 'uuid'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { providers } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import { slugify, findFreeSlug } from '@/server/services/provider-slug'

const log = createLogger('split-multi-capability-providers')

const FAMILY_PREFERENCE = ['llm', 'embedding', 'image'] as const
type Family = (typeof FAMILY_PREFERENCE)[number]

const FAMILY_LABELS: Record<Family, string> = {
  llm: 'LLM',
  embedding: 'Embedding',
  image: 'Image',
}

function pickPrimary(caps: readonly string[]): Family | null {
  for (const f of FAMILY_PREFERENCE) {
    if (caps.includes(f)) return f
  }
  return null
}

export async function splitMultiCapabilityProviders(): Promise<void> {
  const allRows = db.select().from(providers).all()
  const takenSlugs = new Set(allRows.map((r) => r.slug))

  const multiCap = allRows.filter((r) => {
    try {
      const caps = JSON.parse(r.capabilities) as string[]
      return Array.isArray(caps) && caps.length > 1
    } catch {
      return false
    }
  })

  if (multiCap.length === 0) {
    log.debug('No multi-capability provider rows to split')
    return
  }

  log.info({ count: multiCap.length }, 'Splitting multi-capability provider rows into one row per family')

  for (const row of multiCap) {
    let caps: string[]
    try { caps = JSON.parse(row.capabilities) as string[] } catch { continue }
    const primary = pickPrimary(caps)
    if (!primary) continue

    const others = caps.filter((c): c is Family => (FAMILY_PREFERENCE as readonly string[]).includes(c) && c !== primary) as Family[]

    // 1. Narrow the original row to the primary family. Slug + name stay.
    db.update(providers)
      .set({
        family: primary,
        capabilities: JSON.stringify([primary]),
        updatedAt: new Date(),
      })
      .where(eq(providers.id, row.id))
      .run()

    // 2. Insert a sibling row for each remaining family.
    for (const family of others) {
      const newId = uuid()
      const label = FAMILY_LABELS[family]
      const newName = row.name.includes(`(${label})`) ? row.name : `${row.name} (${label})`
      const baseSlug = slugify(`${row.slug}-${family}`)
      const newSlug = findFreeSlug(baseSlug, takenSlugs)
      takenSlugs.add(newSlug)

      db.insert(providers).values({
        id: newId,
        slug: newSlug,
        name: newName,
        type: row.type,
        family,
        configEncrypted: row.configEncrypted,
        capabilities: JSON.stringify([family]),
        isValid: row.isValid,
        lastError: row.lastError,
        createdAt: new Date(),
        updatedAt: new Date(),
      }).run()

      log.info({ originalId: row.id, newId, family, newSlug }, 'Created sibling provider row')
    }
  }

  log.info('Multi-capability provider split complete')
}
