/**
 * Configurator Agent (Queenie) seeding — creates the user's first Agent, the
 * conversational onboarding guide. Idempotent: only one configurator Agent ever
 * exists. See queenie.md.
 */

import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { eq } from "drizzle-orm";
import { db } from "@/server/db/index";
import { agents, providers } from "@/server/db/schema";
import { createAgent } from "@/server/services/agents";
import { getToolboxByName } from "@/server/services/toolboxes";
import { loadProviderConfig } from "@/server/services/provider-config";
import { listModelsForProvider } from "@/server/providers/index";
import { enqueueMessage } from "@/server/services/queue";
import { CONFIGURATOR_MODEL_PREFERENCES } from "@/shared/constants";
import { config } from "@/server/config";
import { sseManager } from "@/server/sse/index";
import { createLogger } from "@/server/logger";

const log = createLogger("configurator");

const QUEENIE = {
  name: "Zidhan",
  role: "AI Assistant Gezy",
  character:
    "Kamu adalah Zidhan, asisten AI yang membantu, ramah, dan profesional. Kamu merespons dalam bahasa Indonesia yang natural dan santai. Kamu membantu dengan pertanyaan apa pun — teknis, sehari-hari, atau sekadar ngobrol.",
  expertise:
    "Kamu adalah asisten AI serba bisa yang membantu pengguna dalam berbagai hal — dari pertanyaan teknis, diskusi santai, sampai bantuan praktis sehari-hari.",
};

/** The single configurator Agent, or undefined if not seeded yet. */
export function getConfiguratorAgent() {
  return db.select().from(agents).where(eq(agents.kind, "configurator")).get();
}

/**
 * Pick a balanced, tool-use-reliable model for Queenie from the bootstrap
 * provider's live catalogue (preference list → first available). Drift-proof.
 */
async function resolveConfiguratorModel(providerId: string): Promise<string> {
  const provider = db
    .select()
    .from(providers)
    .where(eq(providers.id, providerId))
    .get();
  if (!provider) throw new Error(`Provider not found: ${providerId}`);
  const cfg = await loadProviderConfig(provider);
  const models = await listModelsForProvider(provider.type, cfg, "llm");
  const ids = models.filter((m) => m.capability === "llm").map((m) => m.id);
  if (ids.length === 0)
    throw new Error(
      `Provider "${provider.type}" exposes no LLM models to seed the configurator with`,
    );
  const prefs = CONFIGURATOR_MODEL_PREFERENCES[provider.type] ?? [];
  for (const pref of prefs) {
    const p = pref.toLowerCase();
    const matches = ids.filter((id) => id.toLowerCase().includes(p));
    if (matches.length === 0) continue;
    // Drop obvious cheap/small tiers when a full-size sibling exists, so a
    // tool-heavy conversational agent never lands on a nano/mini/lite model.
    const nonLite = matches.filter(
      (id) => !/-(nano|mini|lite|tiny|small|8b)(\b|[-_]|$)/i.test(id),
    );
    return pickStrongestModel(nonLite.length > 0 ? nonLite : matches);
  }
  return ids[0]!;
}

/**
 * Among models matching a preference substring, pick the strongest / most
 * canonical: prefer stable ids over dated / preview / "latest" aliases, then the
 * shortest (canonical) id. Keeps onboarding on a flagship without per-id
 * hardcoding, regardless of the provider API's listing order.
 */
function pickStrongestModel(pool: string[]): string {
  if (pool.length === 1) return pool[0]!;
  const stable = pool.filter(
    (id) => !/(preview|-exp\b|exp-|-latest|beta|alpha|\d{4})/i.test(id),
  );
  const candidates = stable.length > 0 ? stable : pool;
  return candidates.slice().sort((a, b) => a.length - b.length)[0]!;
}

/**
 * Seed the configurator Agent bound to the just-added bootstrap LLM provider.
 * Idempotent — returns the existing one if already seeded (no duplicate, no
 * second kickoff).
 */
export async function seedConfiguratorAgent(
  adminUserId: string,
  providerId: string,
) {
  const existing = getConfiguratorAgent();
  if (existing) return existing;

  const model = await resolveConfiguratorModel(providerId);
  const toolbox = getToolboxByName("configurator");
  if (!toolbox)
    log.warn(
      "configurator toolbox not found — Queenie will fall back to the full toolset",
    );

  // Make the bootstrap provider the default LLM (model + provider) if the user
  // hasn't set one yet — so the Agents they create next inherit a working default.
  const {
    getDefaultLlmProviderId,
    setDefaultLlmModel,
    setDefaultLlmProviderId,
  } = await import("@/server/services/app-settings");
  if (!(await getDefaultLlmProviderId())) {
    await setDefaultLlmModel(model);
    await setDefaultLlmProviderId(providerId);
  }

  const agent = await createAgent({
    name: QUEENIE.name,
    role: QUEENIE.role,
    character: QUEENIE.character,
    expertise: QUEENIE.expertise,
    model,
    providerId,
    kind: "configurator",
    createdBy: adminUserId,
    toolboxIds: toolbox ? [toolbox.id] : null,
  });

  // Assign the bundled avatar (no image provider exists yet, so it is not
  // generated). The asset may ship as png/jpg/webp — match the real extension
  // so it's served with the correct content type.
  try {
    const assetsDir = join(import.meta.dir, "..", "assets");
    let srcPath: string | null = null;
    let ext = "png";
    for (const e of ["png", "jpg", "jpeg", "webp"]) {
      const p = join(assetsDir, `queenie-avatar.${e}`);
      if (existsSync(p)) {
        srcPath = p;
        ext = e === "jpeg" ? "jpg" : e;
        break;
      }
    }
    if (srcPath) {
      const dir = `${config.upload.dir}/agents/${agent.id}`;
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const dest = `${dir}/avatar.${ext}`;
      await Bun.write(dest, Bun.file(srcPath));
      await db
        .update(agents)
        .set({ avatarPath: dest, updatedAt: new Date() })
        .where(eq(agents.id, agent.id));
      sseManager.broadcast({
        type: "agent:updated",
        agentId: agent.id,
        data: {
          agentId: agent.id,
          avatarUrl: `/api/uploads/agents/${agent.id}/avatar.${ext}?v=${Date.now()}`,
        },
      });
    }
  } catch (err) {
    log.warn(
      { agentId: agent.id, err },
      "Failed to assign bundled Queenie avatar",
    );
  }

  // Kickoff: a hidden system trigger so Queenie greets the user first (no user
  // message needed). sourceType 'system' keeps it out of the normal user bubbles.
  await enqueueMessage({
    agentId: agent.id,
    messageType: "user",
    content:
      "[A new user just finished initial setup and opened the onboarding chat. FIRST call get_setup_health (read-only) so your guidance is grounded in the real current state, THEN greet them warmly, introduce yourself as their Hivekeep guide, and start onboarding by getting to know them. Keep it short and friendly.]",
    sourceType: "system",
    priority: config.queue.userPriority,
    // Hidden from the chat UI — it's just the trigger for Queenie's first greeting.
    messageMetadata: { hidden: true },
  });

  log.info({ agentId: agent.id, model }, "Configurator Agent (Queenie) seeded");
  return db.select().from(agents).where(eq(agents.id, agent.id)).get();
}
