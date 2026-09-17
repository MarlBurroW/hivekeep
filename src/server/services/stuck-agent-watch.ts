/**
 * Periodic detection of Agents wedged in "processing".
 *
 * The watchdogs in the engine bound a turn's own work, but they cannot cover
 * everything: a hang in a code path that never reaches them, or an item left
 * behind by an unclean exit, still shows up as an Agent that is busy forever.
 * Recovery for that state used to run only at boot, so it could sit unnoticed
 * for hours — the exact scenario the founder described, where a user's Agent
 * goes quiet and nobody finds out until someone happens to look.
 *
 * Two thresholds, on purpose:
 *  - warn: tell a human. The turn may still be legitimate (a genuinely long
 *    tool run), so we notify and leave it alone.
 *  - recover: past any plausible turn duration, the item is requeued so the
 *    Agent starts answering again instead of staying mute.
 */
import { config } from '@/server/config'
import { createLogger } from '@/server/logger'
import { findStuckProcessingItems, requeueProcessingItems } from '@/server/services/queue'
import { db } from '@/server/db/index'
import { agents } from '@/server/db/schema'
import { eq } from 'drizzle-orm'

const log = createLogger('stuck-agent-watch')

let timer: ReturnType<typeof setInterval> | null = null
/** Agents already reported, so one wedged Agent does not notify every cycle. */
const warned = new Set<string>()

export async function sweepStuckAgents(): Promise<{ warned: number; recovered: number }> {
  const warnMs = config.queue.stuckWarnMs
  const recoverMs = config.queue.stuckRecoverMs
  if (warnMs <= 0 && recoverMs <= 0) return { warned: 0, recovered: 0 }

  const stuck = findStuckProcessingItems(Math.min(warnMs || recoverMs, recoverMs || warnMs))
  let warnedCount = 0
  let recovered = 0

  for (const item of stuck) {
    if (recoverMs > 0 && item.ageMs >= recoverMs) {
      const count = requeueProcessingItems(item.agentId)
      recovered += count
      warned.delete(item.agentId)
      log.error(
        { agentId: item.agentId, queueItemId: item.id, ageMs: item.ageMs, requeued: count },
        'Agent stuck past the recovery threshold — queue items requeued',
      )
      await notify(item.agentId, 'Agent unblocked automatically', 'It had been stuck for too long; its pending message was requeued.')
      continue
    }
    if (warnMs > 0 && item.ageMs >= warnMs && !warned.has(item.agentId)) {
      warned.add(item.agentId)
      warnedCount++
      const minutes = Math.round(item.ageMs / 60_000)
      log.warn({ agentId: item.agentId, queueItemId: item.id, ageMs: item.ageMs }, 'Agent has been processing for a long time')
      await notify(item.agentId, 'Agent still working', `It has been processing the same message for ${minutes} min.`)
    }
  }

  // Anything no longer stuck is eligible to be reported again later.
  const stillStuck = new Set(stuck.map((s) => s.agentId))
  for (const id of warned) if (!stillStuck.has(id)) warned.delete(id)

  return { warned: warnedCount, recovered }
}

async function notify(agentId: string, title: string, body: string): Promise<void> {
  // The Agent's name is cosmetic; the alert is the point. Resolving it in its
  // own guard keeps a lookup failure from swallowing the notification, which
  // would reintroduce exactly the silence this watch exists to end.
  let name: string | undefined
  try {
    name = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get()?.name
  } catch {
    // fall through with no name
  }
  try {
    const { createNotification } = await import('@/server/services/notifications')
    await createNotification({
      type: 'agent:error',
      title: name ? `${title}: ${name}` : title,
      body,
      agentId,
      relatedId: agentId,
      relatedType: 'agent',
    })
  } catch (err) {
    log.error({ agentId, err }, 'Failed to raise stuck-agent notification')
  }
}

export function startStuckAgentWatch(): void {
  if (timer) return
  const run = () => {
    sweepStuckAgents().catch((err) => log.error({ err }, 'Stuck-agent sweep failed'))
  }
  setTimeout(run, 60_000)
  timer = setInterval(run, config.queue.stuckSweepIntervalMs)
  log.info(
    { warnMs: config.queue.stuckWarnMs, recoverMs: config.queue.stuckRecoverMs },
    'Stuck-agent watch scheduled',
  )
}
