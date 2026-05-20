import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  listChannels,
  getChannel,
  listChannelConversations,
  createChannel,
  updateChannel,
  deleteChannel,
  activateChannel,
  deactivateChannel,
  getChannelOriginMeta,
  transferChannel,
} from '@/server/services/channels'
import { searchContacts, getContactWithDetails } from '@/server/services/contacts'
import { resolveKinId } from '@/server/services/kin-resolver'
import { channelAdapters } from '@/server/channels/index'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'
import type { OutboundAttachment } from '@/server/channels/adapter'
import type { ChannelPlatform } from '@/shared/types'

const log = createLogger('tools:channel')

/**
 * list_channels — list all messaging channels connected to this Kin.
 * Available to main agents only.
 */
export const listChannelsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List all messaging channels connected to this Kin.',
      inputSchema: z.object({}),
      execute: async () => {
        const items = await listChannels(ctx.kinId)
        return {
          channels: items.map((ch) => ({
            id: ch.id,
            name: ch.name,
            platform: ch.platform,
            status: ch.status,
            messagesReceived: ch.messagesReceived,
            messagesSent: ch.messagesSent,
            lastActivityAt: ch.lastActivityAt
              ? new Date(ch.lastActivityAt as unknown as number).toISOString()
              : null,
          })),
        }
      },
    }),
}

/**
 * list_channel_conversations — list known users and chat IDs for a channel.
 * Useful for proactive messaging: the Kin needs a chat_id to send messages.
 */
export const listChannelConversationsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List known users and chat IDs for a channel. Use to discover who you can message proactively.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }
        return await listChannelConversations(channel_id)
      },
    }),
}

/**
 * send_channel_message — proactively send a message to an external platform.
 * Enabled by default for main agents. Use `send_to_contact` when you want
 * to address a contact by name without having to look up their chat_id.
 */
export const sendChannelMessageTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Send a message to an external platform via a connected channel. Requires a known platform chat/user id — use send_to_contact when you only know the contact by name.',
      inputSchema: z.object({
        channel_id: z.string(),
        chat_id: z.string().describe('Platform chat/user ID to send to'),
        message: z.string(),
        attachments: z.array(z.object({
          source: z.string().describe('Absolute file path or URL'),
          mimeType: z.string(),
          fileName: z.string().optional(),
        })).optional(),
      }),
      execute: async ({ channel_id, chat_id, message, attachments }) => {
        log.debug({ kinId: ctx.kinId, channelId: channel_id, chatId: chat_id }, 'Channel message send requested')

        // Verify ownership
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }

        if (channel.status !== 'active') {
          return { error: 'Channel is not active' }
        }

        const adapter = channelAdapters.get(channel.platform)
        if (!adapter) {
          return { error: `No adapter for platform ${channel.platform}` }
        }

        try {
          const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
          const outboundAttachments: OutboundAttachment[] | undefined = attachments?.map(a => ({
            source: a.source,
            mimeType: a.mimeType,
            fileName: a.fileName,
          }))
          const result = await adapter.sendMessage(channel_id, cfg, {
            chatId: chat_id,
            content: message,
            attachments: outboundAttachments?.length ? outboundAttachments : undefined,
          })
          return { success: true, platformMessageId: result.platformMessageId }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * send_to_contact — proactively message a contact on a specific platform.
 *
 * Higher-level wrapper around `send_channel_message`. Resolves the
 * contact by name/id, looks up their platform identifier (e.g. their
 * phone number for `twilio-sms`, Telegram user id, Matrix mxid, …),
 * finds an active channel of the right platform owned by this Kin,
 * and dispatches the message.
 *
 * Available to main agents — enabled by default since the resolution
 * step is bounded and any ambiguity returns an error instead of
 * picking blindly.
 */
export const sendToContactTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Proactively send a message to a known contact on a specific platform. Resolves the contact + platform id automatically — give the contact name (or id) and the platform slug (e.g. "twilio-sms", "telegram", "matrix"). Returns an error if the contact is ambiguous, has no identifier for that platform, or this Kin has no active channel for it.',
      inputSchema: z.object({
        contact: z.string().describe('Contact name, display name, nickname, or contact id'),
        platform: z.string().describe('Platform slug, e.g. "twilio-sms", "telegram", "matrix", or a plugin platform like "plugin:kinbot-plugin-teamspeak:teamspeak"'),
        message: z.string(),
        attachments: z.array(z.object({
          source: z.string().describe('Absolute file path or URL'),
          mimeType: z.string(),
          fileName: z.string().optional(),
        })).optional(),
      }),
      execute: async ({ contact, platform, message, attachments }) => {
        log.debug({ kinId: ctx.kinId, contact, platform }, 'send_to_contact requested')

        // 1) Resolve the contact. Try id first, then a fuzzy search.
        let contactRecord = await getContactWithDetails(contact, ctx.kinId)
        if (!contactRecord) {
          const matches = await searchContacts(contact, ctx.kinId)
          if (matches.length === 0) {
            return { error: `No contact matches "${contact}". Use search_contacts or create_contact first.` }
          }
          if (matches.length > 1) {
            return {
              error: `Ambiguous contact "${contact}" — ${matches.length} matches. Resolve by id.`,
              candidates: matches.slice(0, 5).map((m) => ({ id: m.id, displayName: m.displayName })),
            }
          }
          contactRecord = matches[0]!
        }

        // 2) Find the contact's platform identifier for the requested platform.
        const platformLink = contactRecord.platformIds.find((p) => p.platform === platform)
        if (!platformLink) {
          return {
            error: `Contact "${contactRecord.displayName}" has no identifier for platform "${platform}". Available platforms: ${contactRecord.platformIds.map((p) => p.platform).join(', ') || '(none)'}.`,
          }
        }

        // 3) Find an active channel of this platform owned by the Kin.
        //    listChannels is kinId-scoped; we filter to platform + active.
        const channels = await listChannels(ctx.kinId)
        const channel = channels.find((c) => c.platform === platform && c.status === 'active')
        if (!channel) {
          const platformChannels = channels.filter((c) => c.platform === platform)
          if (platformChannels.length === 0) {
            return { error: `No channel configured for platform "${platform}" on this Kin. Add one via create_channel.` }
          }
          return { error: `Channel for platform "${platform}" is not active (status: ${platformChannels[0]!.status}).` }
        }

        // 4) Dispatch via the adapter — same path as send_channel_message.
        const adapter = channelAdapters.get(channel.platform)
        if (!adapter) {
          return { error: `No adapter for platform ${channel.platform}` }
        }

        try {
          const cfg = JSON.parse(channel.platformConfig) as Record<string, unknown>
          const outboundAttachments: OutboundAttachment[] | undefined = attachments?.map((a) => ({
            source: a.source,
            mimeType: a.mimeType,
            fileName: a.fileName,
          }))
          const result = await adapter.sendMessage(channel.id, cfg, {
            chatId: platformLink.platformId,
            content: message,
            attachments: outboundAttachments?.length ? outboundAttachments : undefined,
          })
          return {
            success: true,
            platformMessageId: result.platformMessageId,
            sentTo: { contactId: contactRecord.id, displayName: contactRecord.displayName, platform, chatId: platformLink.platformId },
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * create_channel — create a new messaging channel for this Kin.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const createChannelTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Create a new messaging channel. The `config` keys must match the platform\'s declared configuration fields (e.g. Telegram needs `botToken`; Slack needs `botToken` + `signingSecret`; WhatsApp needs `accessToken` + `phoneNumberId` + `verifyToken`; Matrix needs `homeserverUrl` + `accessToken`). Password-type fields are auto-vaulted by the server — fetch secret values from Vault via get_secret() rather than hardcoding them. If you don\'t know the expected fields for a platform, attempt the call: the validation error lists what\'s missing.',
      inputSchema: z.object({
        name: z.string(),
        platform: z.string().describe('e.g. "telegram", "discord", "slack", "whatsapp", "signal", "matrix", or a plugin platform'),
        config: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .describe('Configuration values keyed by adapter field name (e.g. { botToken: "..." } for Telegram, { botToken: "...", signingSecret: "..." } for Slack).'),
        allowed_chat_ids: z.array(z.string()).optional().describe('Restrict to specific chat/group IDs'),
        auto_create_contacts: z.boolean().optional().describe('Default: true'),
      }),
      execute: async ({ name, platform, config, allowed_chat_ids, auto_create_contacts }) => {
        log.debug({ kinId: ctx.kinId, platform, name, configKeys: Object.keys(config) }, 'Channel creation requested')

        if (!channelAdapters.get(platform)) {
          return { error: `Unknown platform "${platform}". Available: ${channelAdapters.list().join(', ')}` }
        }

        try {
          const channel = await createChannel({
            kinId: ctx.kinId,
            name,
            platform: platform as ChannelPlatform,
            platformConfig: config,
            allowedChatIds: allowed_chat_ids,
            autoCreateContacts: auto_create_contacts,
            createdBy: 'kin',
          })
          return {
            success: true,
            channel: {
              id: channel.id,
              name: channel.name,
              platform: channel.platform,
              status: channel.status,
            },
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * update_channel — update an existing channel's configuration.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const updateChannelTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Update a channel\'s configuration (name, chat restrictions, auto-contact).',
      inputSchema: z.object({
        channel_id: z.string(),
        name: z.string().optional(),
        allowed_chat_ids: z.array(z.string()).optional().describe('Empty array to remove restrictions'),
        auto_create_contacts: z.boolean().optional(),
      }),
      execute: async ({ channel_id, name, allowed_chat_ids, auto_create_contacts }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }

        try {
          const updated = await updateChannel(channel_id, {
            name,
            allowedChatIds: allowed_chat_ids?.length ? allowed_chat_ids : allowed_chat_ids?.length === 0 ? null : undefined,
            autoCreateContacts: auto_create_contacts,
          })
          if (!updated) return { error: 'Update failed' }
          return {
            success: true,
            channel: {
              id: updated.id,
              name: updated.name,
              platform: updated.platform,
              status: updated.status,
            },
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * delete_channel — permanently delete a channel.
 * Opt-in tool (defaultDisabled). Available to main agents only.
 */
export const deleteChannelTool: ToolRegistration = {
  availability: ['main'],
  defaultDisabled: true,
  destructive: true,
  create: (ctx) =>
    tool({
      description:
        'Permanently delete a messaging channel. Only use when explicitly asked.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }

        try {
          const deleted = await deleteChannel(channel_id)
          return deleted ? { success: true } : { error: 'Delete failed' }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * activate_channel — activate an inactive channel (start listening).
 * Available to main agents only.
 */
export const activateChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Activate an inactive channel to start listening for messages.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }

        if (channel.status === 'active') {
          return { error: 'Channel is already active' }
        }

        try {
          const activated = await activateChannel(channel_id)
          if (!activated) return { error: 'Activation failed' }
          return {
            success: activated.status === 'active',
            status: activated.status,
            statusMessage: activated.statusMessage,
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}

/**
 * transfer_channel — re-bind a channel to a different Kin at runtime.
 *
 * Any Kin can call this (no "channel owner" restriction). Effects:
 *   - channels.kinId is mutated to the target Kin.
 *   - Two role='system' audit-trail messages are inserted, one per Kin, with
 *     metadata.systemEvent='channel_transferred_out' / 'channel_transferred_in'.
 *     buildMessageHistory filters these out of the LLM prompt; the UI renders
 *     them as a handoff banner.
 *   - A one-shot channelTransferHint is stashed in the sideband. The next
 *     inbound on the channel pops it and surfaces the handoff via
 *     <channel-context> to the new Kin on its first turn.
 *   - SSE 'channel:transferred' is broadcast so any open UI tab updates the
 *     sidebar binding badge in real time.
 *
 * No turn is triggered on the new Kin at transfer time. The new Kin discovers
 * the conversation when the user next sends a message.
 */
export const transferChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Transfer a channel binding to another Kin. The target Kin will receive the next inbound message on this channel (no immediate turn is triggered). Both Kins get a visible audit-trail row in their conversation. The new Kin also gets a structured note about the handoff (source Kin, optional reason) on its first inbound after the transfer.',
      inputSchema: z.object({
        channelId: z.string().describe('Channel to transfer. Optional when called from a channel-driven turn; inferred from the current context (channelOriginId).').optional(),
        targetKinSlug: z.string().describe('Slug (or UUID) of the Kin to transfer the channel to.'),
        reason: z.string().max(200).optional().describe('Optional human-readable explanation, shown in the audit trail and surfaced to the new Kin as context.'),
      }),
      execute: async ({ channelId, targetKinSlug, reason }) => {
        // Resolve channelId (explicit > inferred from the current channel turn).
        let resolvedChannelId = channelId
        if (!resolvedChannelId && ctx.channelOriginId) {
          const origin = getChannelOriginMeta(ctx.channelOriginId)
          if (origin) resolvedChannelId = origin.channelId
        }
        if (!resolvedChannelId) {
          return { error: 'channelId could not be inferred from the current context; please pass it explicitly.' }
        }

        // Resolve the target Kin slug/UUID to a UUID; the service does the
        // rest (channel + Kin row loads, mutation, audit rows, sideband hint,
        // SSE broadcast, onIdentityChange).
        const toKinId = resolveKinId(targetKinSlug)
        if (!toKinId) {
          return { error: `Kin "${targetKinSlug}" not found (unknown slug or UUID).` }
        }

        const result = await transferChannel({
          channelId: resolvedChannelId,
          targetKinId: toKinId,
          reason,
          initiatedBy: 'tool',
          calledByKinId: ctx.kinId,
        })

        if (result.ok === false) {
          return { error: result.error }
        }
        if (result.noop) {
          return { ok: true, noop: true, message: result.message }
        }
        return {
          ok: true,
          transferredAt: result.transferredAt,
          previousKinSlug: result.previousKinSlug,
          newKinSlug: result.newKinSlug,
        }
      },
    }),
}

/**
 * deactivate_channel — deactivate an active channel (stop listening).
 * Available to main agents only.
 */
export const deactivateChannelTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Deactivate an active channel to stop listening for messages.',
      inputSchema: z.object({
        channel_id: z.string(),
      }),
      execute: async ({ channel_id }) => {
        const channel = await getChannel(channel_id)
        if (!channel || channel.kinId !== ctx.kinId) {
          return { error: 'Channel not found' }
        }

        if (channel.status === 'inactive') {
          return { error: 'Channel is already inactive' }
        }

        try {
          const deactivated = await deactivateChannel(channel_id)
          if (!deactivated) return { error: 'Deactivation failed' }
          return { success: true, status: deactivated.status }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        }
      },
    }),
}
