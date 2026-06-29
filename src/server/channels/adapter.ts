/**
 * Channel adapter types — re-exports from the SDK. Single source of
 * truth in `packages/sdk/src/index.ts`. Server-side modules keep the
 * existing import path (`@/server/channels/adapter`) for stability
 * across every built-in channel adapter; plugin authors should
 * import directly from `@gezy/sdk` instead.
 *
 * This file also keeps the outbound-attachment helpers (file/URL
 * reading, name derivation, image detection) since they're host-side
 * concerns that don't belong in a published SDK.
 */

import { existsSync } from 'fs'

export type {
  ChannelAdapter,
  ChannelAdapterMeta,
  ChannelConfigField,
  ChannelConfigSchema,
  ChannelEndpoint,
  ChannelPairingEvent,
  ChannelStartHandlers,
  DeliveryStatus,
  DeliveryStatusUpdate,
  IncomingAttachment,
  IncomingMessage,
  IncomingMessageHandler,
  OutboundAttachment,
  OutboundMessageParams,
  OutboundMessageResult,
} from '@gezy/sdk'

import type { OutboundAttachment } from '@gezy/sdk'

// ─── Outbound attachment helpers (host-only) ────────────────────────────────

/**
 * Read an OutboundAttachment into a Blob suitable for multipart uploads.
 * Supports local file paths and HTTP(S) URLs.
 */
export async function readAttachmentBlob(att: OutboundAttachment): Promise<Blob> {
  if (att.source.startsWith('http://') || att.source.startsWith('https://')) {
    const resp = await fetch(att.source)
    if (!resp.ok) throw new Error(`Failed to fetch attachment URL: ${resp.status}`)
    return await resp.blob()
  }
  // Local file
  if (!existsSync(att.source)) throw new Error(`Attachment file not found: ${att.source}`)
  const file = Bun.file(att.source)
  return file
}

/**
 * Derive a file name for an outbound attachment.
 */
export function attachmentFileName(att: OutboundAttachment): string {
  if (att.fileName) return att.fileName
  // Try to extract from source path/URL
  const lastSegment = att.source.split('/').pop()?.split('?')[0]
  if (lastSegment && lastSegment.includes('.')) return lastSegment
  // Fallback based on mime type
  const ext = att.mimeType.split('/')[1]?.split('+')[0] ?? 'bin'
  return `file.${ext}`
}

/**
 * Check if an attachment is an image type.
 */
export function isImageAttachment(att: OutboundAttachment): boolean {
  return att.mimeType.startsWith('image/')
}
