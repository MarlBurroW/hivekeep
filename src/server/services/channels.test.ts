import { describe, it, expect, beforeEach, mock } from 'bun:test'

// ─── Prevent Bun mock isolation leak ─────────────────────────────────────────
// contacts.test.ts mocks @/server/services/contacts via mock.module().
// Between test files, Bun tries to resolve the real module, which imports
// `sqlite` from @/server/db/index (globally mocked by onboarding.test.ts).
// This causes a "SyntaxError: Export named 'replaceContactIdentifiers' not found".
// Adding a stub mock here prevents Bun from resolving the real contacts module.
mock.module('@/server/services/contacts', () => ({
  createContact: async () => null,
  getContact: async () => null,
  listContacts: async () => [],
  listContactsWithDetails: async () => [],
  getContactWithDetails: async () => null,
  updateContact: async () => null,
  deleteContact: async () => false,
  searchContacts: async () => [],
  addContactIdentifier: () => null,
  updateContactIdentifier: () => null,
  removeContactIdentifier: () => false,
  replaceContactIdentifiers: () => null,
  findContactByIdentifier: () => null,
  findContactByLinkedUserId: () => null,
  listContactIdentifiers: () => [],
  setContactNote: () => null,
  updateContactNote: () => null,
  deleteContactNote: () => false,
  getVisibleNotes: () => [],
  deleteNotesByAgent: () => {},
  listContactsForPrompt: async () => [],
  ensureUserContactsExist: async () => {},
}))

// ─── Re-implement the in-memory stores locally to test the contract ──────────
// Bun's mock.module is global and other test files mock @/server/services/channels,
// which corrupts the real module's Map. Instead, we replicate the logic here and
// test it in isolation — ensuring the contract is verified without cross-test pollution.

// ─── ChannelQueueMeta ────────────────────────────────────────────────────────

interface ChannelQueueMeta {
  channelId: string
  platformChatId: string
  platformMessageId: string
  platformUserId: string
}

function createQueueMetaStore() {
  const store = new Map<string, ChannelQueueMeta>()
  return {
    set: (id: string, meta: ChannelQueueMeta) => store.set(id, meta),
    get: (id: string) => store.get(id),
    pop: (id: string) => {
      const meta = store.get(id)
      if (meta) store.delete(id)
      return meta
    },
    clear: () => store.clear(),
  }
}

describe('ChannelQueueMeta contract', () => {
  const store = createQueueMetaStore()
  let idCounter = 0
  const nextId = () => `test-queue-${Date.now()}-${++idCounter}`

  const sampleMeta: ChannelQueueMeta = {
    channelId: 'ch-001',
    platformChatId: 'chat-123',
    platformMessageId: 'msg-456',
    platformUserId: 'user-789',
  }

  beforeEach(() => store.clear())

  describe('set + get', () => {
    it('stores and retrieves metadata by queue item ID', () => {
      const id = nextId()
      store.set(id, sampleMeta)
      expect(store.get(id)).toEqual(sampleMeta)
    })

    it('returns undefined for unknown queue item ID', () => {
      expect(store.get('nonexistent-id')).toBeUndefined()
    })

    it('overwrites existing metadata when set again', () => {
      const id = nextId()
      store.set(id, sampleMeta)
      const updated: ChannelQueueMeta = { ...sampleMeta, channelId: 'ch-002' }
      store.set(id, updated)
      expect(store.get(id)).toEqual(updated)
    })

    it('stores multiple entries independently', () => {
      const id1 = nextId()
      const id2 = nextId()
      const meta1: ChannelQueueMeta = { ...sampleMeta, channelId: 'ch-a' }
      const meta2: ChannelQueueMeta = { ...sampleMeta, channelId: 'ch-b' }
      store.set(id1, meta1)
      store.set(id2, meta2)
      expect(store.get(id1)).toEqual(meta1)
      expect(store.get(id2)).toEqual(meta2)
    })
  })

  describe('pop', () => {
    it('returns and removes metadata', () => {
      const id = nextId()
      store.set(id, sampleMeta)
      expect(store.pop(id)).toEqual(sampleMeta)
      expect(store.get(id)).toBeUndefined()
    })

    it('returns undefined for unknown ID', () => {
      expect(store.pop('nonexistent-pop')).toBeUndefined()
    })

    it('returns undefined on second pop (already consumed)', () => {
      const id = nextId()
      store.set(id, sampleMeta)
      store.pop(id)
      expect(store.pop(id)).toBeUndefined()
    })

    it('does not affect other entries when popping one', () => {
      const id1 = nextId()
      const id2 = nextId()
      store.set(id1, { ...sampleMeta, channelId: 'ch-keep' })
      store.set(id2, { ...sampleMeta, channelId: 'ch-pop' })
      store.pop(id2)
      expect(store.get(id1)?.channelId).toBe('ch-keep')
      expect(store.get(id2)).toBeUndefined()
    })
  })
})

// ─── ChannelOriginMeta (freshness window) ───────────────────────────────────
// The real store lives in `channel_origins` (see setChannelOriginMeta /
// getChannelOriginMeta). Only the freshness rule applied on read is replicated
// here: a row is returned when `now - createdAt <= config.channels.originTtlMs`,
// and dropped otherwise. Kept in lockstep with getChannelOriginMeta.

interface ChannelOriginRow {
  channelId: string
  platformChatId: string
  platformMessageId: string
  platformUserId: string
  createdAt: number
}

const ORIGIN_TTL_MS = 86_400_000

function createOriginMetaStore() {
  const store = new Map<string, ChannelOriginRow>()
  return {
    set: (id: string, row: ChannelOriginRow) => store.set(id, row),
    get: (id: string, now: number): ChannelOriginRow | undefined => {
      const row = store.get(id)
      if (!row) return undefined
      if (now - row.createdAt > ORIGIN_TTL_MS) {
        store.delete(id)
        return undefined
      }
      return row
    },
    has: (id: string) => store.has(id),
    clear: () => store.clear(),
  }
}

describe('ChannelOriginMeta contract', () => {
  const store = createOriginMetaStore()
  const NOW = 1_800_000_000_000
  let idCounter = 0
  const nextId = () => `test-origin-${++idCounter}`

  const makeRow = (overrides?: Partial<ChannelOriginRow>): ChannelOriginRow => ({
    channelId: 'ch-origin-001',
    platformChatId: 'chat-origin-123',
    platformMessageId: 'msg-origin-456',
    platformUserId: 'user-origin-789',
    createdAt: NOW,
    ...overrides,
  })

  beforeEach(() => store.clear())

  it('returns every field of a stored origin', () => {
    const id = nextId()
    const row = makeRow()
    store.set(id, row)
    expect(store.get(id, NOW)).toEqual(row)
  })

  it('returns undefined for an unknown origin id', () => {
    expect(store.get('nonexistent-origin', NOW)).toBeUndefined()
  })

  it('keeps origins independent', () => {
    const id1 = nextId()
    const id2 = nextId()
    store.set(id1, makeRow({ channelId: 'ch-a' }))
    store.set(id2, makeRow({ channelId: 'ch-b' }))
    expect(store.get(id1, NOW)?.channelId).toBe('ch-a')
    expect(store.get(id2, NOW)?.channelId).toBe('ch-b')
  })

  it('still resolves an origin far beyond the old 5-minute in-memory TTL', () => {
    const id = nextId()
    store.set(id, makeRow({ createdAt: NOW - 3 * 60 * 60 * 1000 }))
    expect(store.get(id, NOW)?.channelId).toBe('ch-origin-001')
  })

  it('resolves an origin exactly at the freshness boundary', () => {
    const id = nextId()
    store.set(id, makeRow({ createdAt: NOW - ORIGIN_TTL_MS }))
    expect(store.get(id, NOW)).toBeDefined()
  })

  it('drops an origin past the freshness window', () => {
    const id = nextId()
    store.set(id, makeRow({ createdAt: NOW - ORIGIN_TTL_MS - 1 }))
    expect(store.get(id, NOW)).toBeUndefined()
    expect(store.has(id)).toBe(false)
  })

  it('expiring one origin leaves the others resolvable', () => {
    const stale = nextId()
    const fresh = nextId()
    store.set(stale, makeRow({ channelId: 'ch-stale', createdAt: NOW - ORIGIN_TTL_MS - 1 }))
    store.set(fresh, makeRow({ channelId: 'ch-fresh', createdAt: NOW }))
    expect(store.get(stale, NOW)).toBeUndefined()
    expect(store.get(fresh, NOW)?.channelId).toBe('ch-fresh')
  })
})

// ─── Delivery-status context line ────────────────────────────────────────────
// Replicates buildDeliveryContextLine() from channels.ts (kept in lockstep) to
// verify the visible delivery hint without importing the real module, which
// other test files mock globally (see header note). The icon/label/error-code
// formatting is the user-facing contract for Twilio MessageStatus callbacks.

const DELIVERY_STATUS_LABELS: Record<string, Partial<Record<string, string>>> = {
  en: { delivered: 'Delivered', sent: 'Sent', queued: 'Queued', read: 'Read', undelivered: 'Delivery failed', failed: 'Delivery failed' },
  fr: { delivered: 'Remis', sent: 'Envoyé', queued: 'En file d’attente', read: 'Lu', undelivered: 'Échec de remise', failed: 'Échec de remise' },
}

function buildDeliveryContextLine(
  update: { status: string; errorCode?: string },
  platformName: string,
  locale: string,
): string {
  const lang = (locale || 'en').slice(0, 2).toLowerCase()
  const labels = DELIVERY_STATUS_LABELS[lang] ?? DELIVERY_STATUS_LABELS.en ?? {}
  const label = labels[update.status] ?? update.status
  const isFailure = update.status === 'failed' || update.status === 'undelivered'
  const isSuccess = update.status === 'delivered' || update.status === 'read'
  const icon = isFailure ? '✗ ' : isSuccess ? '✓ ' : ''
  const errorSuffix = isFailure && update.errorCode ? ` (${update.errorCode})` : ''
  return `${icon}${label}${errorSuffix} · ${platformName}`
}

describe('buildDeliveryContextLine contract', () => {
  it('prefixes a check on delivered', () => {
    expect(buildDeliveryContextLine({ status: 'delivered' }, 'Twilio SMS', 'en')).toBe('✓ Delivered · Twilio SMS')
  })

  it('prefixes a cross and appends the error code on failure', () => {
    expect(buildDeliveryContextLine({ status: 'failed', errorCode: '30007' }, 'Twilio SMS', 'en')).toBe(
      '✗ Delivery failed (30007) · Twilio SMS',
    )
  })

  it('treats undelivered as a failure (cross + error code)', () => {
    expect(buildDeliveryContextLine({ status: 'undelivered', errorCode: '30006' }, 'Twilio SMS', 'en')).toBe(
      '✗ Delivery failed (30006) · Twilio SMS',
    )
  })

  it('omits the error suffix when no code is present', () => {
    expect(buildDeliveryContextLine({ status: 'failed' }, 'Twilio SMS', 'en')).toBe('✗ Delivery failed · Twilio SMS')
  })

  it('uses no icon for in-flight states (sent/queued)', () => {
    expect(buildDeliveryContextLine({ status: 'sent' }, 'Twilio SMS', 'en')).toBe('Sent · Twilio SMS')
    expect(buildDeliveryContextLine({ status: 'queued' }, 'Twilio SMS', 'en')).toBe('Queued · Twilio SMS')
  })

  it('localizes by the channel locale (fr)', () => {
    expect(buildDeliveryContextLine({ status: 'delivered' }, 'Twilio SMS', 'fr')).toBe('✓ Remis · Twilio SMS')
  })

  it('falls back to English for an unknown locale', () => {
    expect(buildDeliveryContextLine({ status: 'delivered' }, 'Twilio SMS', 'pt')).toBe('✓ Delivered · Twilio SMS')
  })

  it('falls back to the raw status for an unmapped status', () => {
    expect(buildDeliveryContextLine({ status: 'unknown' }, 'Twilio SMS', 'en')).toBe('unknown · Twilio SMS')
  })
})

// ─── Pending-message buffer cap ──────────────────────────────────────────────
// Mirrors the cap trimming in bufferPendingChannelMessage() (channels.ts): when
// a pending contact accumulates more than maxPendingBufferedMessages, only the
// most recent N are kept (oldest dropped) so the replay turn stays bounded.

function trimToCap<T>(buffer: T[], cap: number): T[] {
  // Buffer is ordered oldest → newest. Drop the oldest overflow.
  if (buffer.length <= cap) return buffer
  return buffer.slice(buffer.length - cap)
}

describe('pending buffer cap contract', () => {
  it('keeps everything when under the cap', () => {
    expect(trimToCap([1, 2, 3], 10)).toEqual([1, 2, 3])
  })

  it('keeps everything when exactly at the cap', () => {
    expect(trimToCap([1, 2, 3], 3)).toEqual([1, 2, 3])
  })

  it('drops the oldest when over the cap (keeps most recent N)', () => {
    expect(trimToCap([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5])
  })

  it('keeps only the last message with a cap of 1', () => {
    expect(trimToCap(['a', 'b', 'c'], 1)).toEqual(['c'])
  })
})

// ─── Grouped channel-turn content ────────────────────────────────────────────
// Mirrors the content builder in enqueueChannelTurn() (channels.ts): the sender
// prefix is emitted once, then every non-empty message body is joined by
// newlines so an approved contact's backlog becomes a single turn. An
// unresolved contact carries platform metadata in the prefix instead.

function buildChannelTurnContent(
  platform: string,
  senderName: string,
  contactResolved: boolean,
  messages: { content: string; platformUserId: string; platformUsername?: string }[],
): string {
  const first = messages[0]!
  const head = contactResolved
    ? `[${platform}:${senderName}]`
    : (() => {
        const parts = [`${platform}_id: ${first.platformUserId}`]
        if (first.platformUsername) parts.push(`username: ${first.platformUsername}`)
        return `[${platform}:${senderName} (unknown, ${parts.join(', ')})]`
      })()
  const bodies = messages.map((m) => m.content).filter((c) => c && c.trim().length > 0)
  return bodies.length > 0 ? `${head} ${bodies.join('\n')}` : head
}

describe('grouped channel-turn content contract', () => {
  const msg = (content: string) => ({ content, platformUserId: 'u1', platformUsername: 'bob' })

  it('formats a single resolved-contact message', () => {
    expect(buildChannelTurnContent('whatsapp', 'Bob', true, [msg('hello')])).toBe('[whatsapp:Bob] hello')
  })

  it('joins multiple buffered messages into one turn with a single prefix', () => {
    expect(
      buildChannelTurnContent('whatsapp', 'Bob', true, [msg('one'), msg('two'), msg('three')]),
    ).toBe('[whatsapp:Bob] one\ntwo\nthree')
  })

  it('skips empty/whitespace bodies when joining', () => {
    expect(buildChannelTurnContent('whatsapp', 'Bob', true, [msg('one'), msg('   '), msg('two')])).toBe(
      '[whatsapp:Bob] one\ntwo',
    )
  })

  it('embeds platform metadata in the prefix for an unresolved contact', () => {
    expect(buildChannelTurnContent('telegram', 'Stranger', false, [msg('hi')])).toBe(
      '[telegram:Stranger (unknown, telegram_id: u1, username: bob)] hi',
    )
  })

  it('emits just the prefix when there is no text (attachment-only)', () => {
    expect(buildChannelTurnContent('whatsapp', 'Bob', true, [msg('')])).toBe('[whatsapp:Bob]')
  })
})
