/**
 * External plugin fixture — simulates a third-party plugin published on
 * npm. The whole module imports from `@kinbot-developer/sdk` only;
 * nothing from KinBot internals (no `@/server/...`, no `@/shared/...`).
 *
 * Loaded by `src/server/services/plugins-e2e.test.ts` to prove the SDK
 * contract works end-to-end for plugins that don't live in the kinbot
 * tree.
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
  type ProviderConfig,
} from '@kinbot-developer/sdk'

interface ExternalConfig {
  greeting?: string
}

// ─── A real native LLMProvider, complete with streaming chat ────────────────

class ExternalLLMProvider implements LLMProvider {
  readonly type = 'external-echo'
  readonly displayName = 'External Echo (fixture)'
  readonly noApiKey = true
  readonly configSchema = [
    { key: 'baseUrl', type: 'url', label: 'Base URL', default: 'http://localhost' },
  ] as const

  async authenticate(_config: ProviderConfig) {
    return { valid: true, accountLabel: 'fixture-account' }
  }

  async listModels(_config: ProviderConfig) {
    return [
      { id: 'external-1', name: 'External 1', contextWindow: 8192 },
      { id: 'external-2', name: 'External 2', contextWindow: 32768 },
    ]
  }

  async *chat(
    _model: { id: string },
    request: ChatRequest,
    _config: ProviderConfig,
  ): AsyncIterable<ChatChunk> {
    const last = [...request.messages].reverse().find((m) => m.role === 'user')
    const text =
      last?.content.find((b) => b.type === 'text')?.text ?? '(no input)'
    yield { type: 'text-delta', text: `[external] ${text}` }
    yield {
      type: 'finish',
      reason: 'stop',
      usage: {
        inputTokens: text.length,
        outputTokens: `[external] ${text}`.length,
      },
    }
  }
}

// ─── A real ChannelAdapter ──────────────────────────────────────────────────

const externalChannel: ChannelAdapter = {
  platform: 'external-channel',
  meta: { displayName: 'External Channel (fixture)' },
  identitySwitchMode: 'prefix',
  async start() {},
  async stop() {},
  async sendMessage(_channelId, _config, params) {
    return {
      platformMessageId: `ext-${Date.now()}`,
      deliveryMeta: { content: params.content, chatId: params.chatId },
    }
  },
  async validateConfig() {
    return { valid: true }
  },
  async getBotInfo() {
    return { name: 'External Bot' }
  },
}

// ─── Entry point ────────────────────────────────────────────────────────────

export default function externalPlugin(
  ctx: PluginContext<ExternalConfig>,
): PluginExports {
  ctx.log.info('external plugin loaded')

  return {
    tools: {
      hello: {
        availability: ['main', 'sub-kin'],
        readOnly: true,
        concurrencySafe: true,
        create: (execCtx) =>
          tool({
            description: 'Greet someone using the plugin\'s configured word.',
            inputSchema: z.object({
              name: z.string().describe('Who to greet'),
            }),
            execute: async ({ name }) => {
              const word = ctx.config.greeting ?? 'Hello'
              await ctx.cards.emit({
                kinId: execCtx.kinId,
                cardType: 'hello-card',
                layout: [
                  card.header({ title: `${word} card` }),
                  card.statusBanner({ label: `${word}, ${name}!`, variant: 'success' }),
                ],
                initialState: { name },
              })
              return { reply: `${word}, ${name}!` }
            },
          }),
      },
    },

    channels: {
      'external-channel': externalChannel,
    },

    providers: [new ExternalLLMProvider()],

    hooks: {
      beforeChat: (h) => {
        ctx.log.debug({ kinId: h.kinId, len: h.message.length }, 'beforeChat')
      },
      afterToolCall: (h) => {
        ctx.log.debug({ tool: h.toolName }, 'afterToolCall')
      },
    },

    async onCardAction({ actionId }) {
      ctx.log.info({ actionId }, 'card action')
      return { ok: true }
    },

    async activate() {
      ctx.log.info('external plugin activated')
    },
    async deactivate() {
      ctx.log.info('external plugin deactivated')
    },
  }
}
