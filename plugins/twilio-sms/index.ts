/**
 * KinBot plugin: twilio-sms
 *
 * Channel adapter that sends and receives SMS via Twilio:
 *   - outbound: POST to https://api.twilio.com/2010-04-01/Accounts/{sid}/Messages.json
 *   - inbound: signed webhook at /api/channels/plugin/twilio-sms/webhook/{channelId}
 *
 * This file is the scaffold. Real outbound and inbound logic land in the
 * following commits; sendMessage and handleInboundWebhook here are stubs.
 */

import type {
  ChannelAdapter,
  IncomingMessage,
  IncomingMessageHandler,
  OutboundMessageParams,
  OutboundMessageResult,
} from '@/server/channels/adapter'

// ─── Plugin context (loose typing, mirrors the teamspeak plugin) ────────────

interface PluginCtxLog {
  debug(msg: string): void
  debug(obj: Record<string, unknown>, msg: string): void
  info(msg: string): void
  info(obj: Record<string, unknown>, msg: string): void
  warn(msg: string): void
  warn(obj: Record<string, unknown>, msg: string): void
  error(msg: string): void
  error(obj: Record<string, unknown>, msg: string): void
}

interface PluginCtx {
  config: Record<string, unknown>
  log: PluginCtxLog
  manifest: { name: string; version: string }
}

// ─── Resolved channel config shape ──────────────────────────────────────────
// Stored in `channels.platformConfig` as JSON. The Auth Token is a password
// field so KinBot replaces it with `authTokenVaultKey` on persistence; the
// real value is fetched from the vault at use time. Plain-text fallback is
// supported for tests and dev-time fixtures.

export interface TwilioChannelConfig {
  accountSid: string
  authToken?: string
  authTokenVaultKey?: string
  fromNumber: string
}

// ─── Plugin entry point ─────────────────────────────────────────────────────

export default function twilioSmsPlugin(ctx: PluginCtx): {
  channels: { 'twilio-sms': ChannelAdapter }
  activate?: () => Promise<void>
  deactivate?: () => Promise<void>
} {
  const adapter: ChannelAdapter = {
    platform: 'twilio-sms',
    meta: {
      displayName: 'Twilio SMS',
      brandColor: '#F22F46',
    },

    async start(
      channelId: string,
      _config: Record<string, unknown>,
      _onMessage: IncomingMessageHandler,
    ): Promise<void> {
      // Twilio is webhook-driven; nothing to start at the transport layer.
      // The dispatcher route invokes handleInboundWebhook on each request.
      ctx.log.info({ channelId }, 'twilio-sms channel started')
    },

    async stop(channelId: string): Promise<void> {
      ctx.log.info({ channelId }, 'twilio-sms channel stopped')
    },

    async validateConfig(_config: Record<string, unknown>): Promise<{ valid: boolean; error?: string }> {
      // Real implementation lands in commit 2 (pings Accounts/{sid}.json).
      return { valid: true }
    },

    async getBotInfo(config: Record<string, unknown>): Promise<{ name: string; username?: string } | null> {
      const cfg = config as Partial<TwilioChannelConfig>
      return {
        name: 'Twilio SMS',
        username: cfg.fromNumber ?? undefined,
      }
    },

    async sendMessage(
      _channelId: string,
      _config: Record<string, unknown>,
      _params: OutboundMessageParams,
    ): Promise<OutboundMessageResult> {
      throw new Error('twilio-sms sendMessage not implemented yet')
    },

    async handleInboundWebhook(
      _channelId: string,
      _config: Record<string, unknown>,
      _req: Request,
    ): Promise<{ incoming: IncomingMessage | null; response: Response }> {
      throw new Error('twilio-sms handleInboundWebhook not implemented yet')
    },
  }

  return {
    channels: { 'twilio-sms': adapter },

    async activate(): Promise<void> {
      ctx.log.info({ plugin: ctx.manifest.name, version: ctx.manifest.version }, 'twilio-sms plugin activated')
    },

    async deactivate(): Promise<void> {
      ctx.log.info('twilio-sms plugin deactivated')
    },
  }
}
