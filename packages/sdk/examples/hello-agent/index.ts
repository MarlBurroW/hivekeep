/**
 * @gezy/sdk — `hello-agent` reference example.
 *
 * Demonstrates every plugin extension point Hivekeep supports:
 *   - tools         (LLM-callable function with typed args)
 *   - channels      (a tiny stub channel adapter)
 *   - providers     (a tiny stub LLMProvider)
 *   - hooks         (typed payloads per hook name)
 *   - cards         (build a rich card with the card.* builders)
 *   - ctx           (typed config, vault, storage, http, log, manifest)
 *
 * This file is exercised by `packages/sdk/src/example.test.ts` so any
 * future SDK change that breaks the example fails CI.
 */

import {
  tool,
  z,
  card,
  type ChannelAdapter,
  type ChatChunk,
  type ChatRequest,
  type LLMProvider,
  type PluginContext,
  type PluginExports,
} from '@gezy/sdk'

interface HelloAgentConfig {
  greeting?: string
  apiKey?: string
}

// ─── A stub LLMProvider implementing the native interface ────────────────────

class EchoLLMProvider implements LLMProvider {
  readonly type = 'echo'
  readonly displayName = 'Echo (example)'
  readonly noApiKey = true
  readonly configSchema = [
    { key: 'baseUrl', type: 'url', label: 'Base URL (unused)', default: 'http://localhost' },
  ] as const

  async authenticate() {
    return { valid: true }
  }

  async listModels() {
    return [{ id: 'echo-1', name: 'Echo 1', contextWindow: 4096 }]
  }

  async *chat(
    _model: { id: string },
    request: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    const lastUser = [...request.messages].reverse().find((m) => m.role === 'user')
    const text =
      lastUser?.content.find((b) => b.type === 'text')?.text ?? '(no text)'
    yield { type: 'text-delta', text: `Echo: ${text}` }
    yield {
      type: 'finish',
      reason: 'stop',
      usage: { inputTokens: text.length, outputTokens: text.length + 6 },
    }
  }
}

// ─── A stub ChannelAdapter — webhook-only, no transport ──────────────────────

const echoChannel: ChannelAdapter = {
  platform: 'echo-channel',
  meta: { displayName: 'Echo Channel (example)' },
  async start() {},
  async stop() {},
  async validateConfig() {
    return { valid: true }
  },
  async getBotInfo() {
    return { name: 'Echo Bot' }
  },
  async sendMessage(_channelId, _config, params) {
    return { platformMessageId: `echo-${Date.now()}`, deliveryMeta: { content: params.content } }
  },
}

// ─── Plugin entry point ──────────────────────────────────────────────────────

export default function helloAgentPlugin(
  ctx: PluginContext<HelloAgentConfig>,
): PluginExports {
  ctx.log.info('hello-agent loaded')

  return {
    // 1. A tool — LLM-callable, typed args, typed result.
    tools: {
      greet: {
        availability: ['main', 'sub-agent'],
        readOnly: true,
        concurrencySafe: true,
        create: (execCtx) =>
          tool({
            description: 'Greet someone using the plugin\'s configured greeting.',
            inputSchema: z.object({
              name: z.string().describe('Who to greet'),
            }),
            execute: async ({ name }) => {
              const word = ctx.config.greeting ?? 'Hi'
              ctx.log.info({ agentId: execCtx.agentId, name }, 'greet invoked')

              // Emit a card so the chat shows a richer panel than just a text reply.
              const { cardInstanceId } = await ctx.cards.emit({
                agentId: execCtx.agentId,
                cardType: 'greet-result',
                layout: [
                  card.header({ title: 'Greeting sent', icon: 'Sparkles' }),
                  card.statusBanner({
                    label: `${word}, ${name}!`,
                    variant: 'success',
                  }),
                  card.infoGrid({
                    items: [
                      { label: 'Plugin', value: ctx.manifest.name },
                      { label: 'Version', value: ctx.manifest.version },
                    ],
                  }),
                ],
                initialState: { name },
              })

              return { reply: `${word}, ${name}!`, cardInstanceId }
            },
          }),
      },
    },

    // 2. A channel adapter — registered under its `platform` name.
    channels: {
      'echo-channel': echoChannel,
    },

    // 3. A native LLM provider — same shape as the built-in ones.
    providers: [new EchoLLMProvider()],

    // 4. Hooks with typed payloads.
    hooks: {
      beforeChat: (h) => {
        ctx.log.debug({ agentId: h.agentId, msgLen: h.message.length }, 'beforeChat')
      },
      afterToolCall: (h) => {
        ctx.log.debug(
          { tool: h.toolName, isError: h.toolResult && (h.toolResult as { error?: unknown }).error != null },
          'afterToolCall',
        )
      },
    },

    // 5. Card action handler — runs when the user clicks a button on a card emitted by this plugin.
    async onCardAction({ actionId, cardInstanceId }) {
      ctx.log.info({ actionId, cardInstanceId }, 'card action received')
      return { ok: true }
    },

    // 6. Lifecycle.
    async activate() {
      // open persistent connections, schedule timers, …
      ctx.log.info('hello-agent activated')
    },
    async deactivate() {
      // close connections, flush state, …
      ctx.log.info('hello-agent deactivated')
    },
  }
}
