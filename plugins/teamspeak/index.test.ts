import { describe, it, expect } from 'bun:test'
import createPlugin, { buildOutboundContextLine } from './index'
import { normalizeUid } from './wsClient'

function makeCtx(overrides?: Partial<Record<string, unknown>>) {
  return {
    config: {
      wsUrl: 'ws://127.0.0.1:8080/ws',
      ttsMaxChars: 300,
      enableTtsOnPublic: true,
      reconnectMaxBackoffMs: 30000,
      ...overrides,
    },
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    storage: {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
      clear: async () => {},
    },
    manifest: { name: 'teamspeak', version: '0.1.0' },
  }
}

describe('teamspeak plugin export shape', () => {
  it('exposes tools, channels, activate and deactivate', () => {
    const plugin = createPlugin(makeCtx() as any)
    expect(plugin.tools).toBeDefined()
    expect(plugin.channels).toBeDefined()
    expect(typeof plugin.activate).toBe('function')
    expect(typeof plugin.deactivate).toBe('function')
  })

  it('declares all expected tools', () => {
    const plugin = createPlugin(makeCtx() as any)
    const names = Object.keys(plugin.tools)
    expect(names.sort()).toEqual(
      [
        'get_status',
        'move_channel',
        'send_chat',
        'speak',
        'stop_speaking',
        // Client moderation
        'poke_client',
        'kick_client',
        'move_client',
        // Bot self-management
        'set_nickname',
        // Server info
        'get_server_info',
        // Channel admin
        'create_channel',
        'set_channel_description',
        'delete_channel',
        // Voice listening
        'activate_listener',
        'deactivate_listener',
        'set_language',
        // TTS parameters
        'set_volume',
        'get_volume',
        'set_voice',
        'get_voice',
        'set_speed',
        'get_speed',
        // STT timeout
        'set_timeout',
        'get_timeout',
        // History
        'get_history',
      ].sort(),
    )
  })

  it('declares the teamspeak channel adapter', () => {
    const plugin = createPlugin(makeCtx() as any)
    const adapter = (plugin.channels as Record<string, any>).teamspeak
    expect(adapter).toBeDefined()
    expect(adapter.platform).toBe('teamspeak')
    expect(adapter.meta?.displayName).toBe('TeamSpeak')
    expect(typeof adapter.start).toBe('function')
    expect(typeof adapter.stop).toBe('function')
    expect(typeof adapter.sendMessage).toBe('function')
    expect(typeof adapter.validateConfig).toBe('function')
    expect(typeof adapter.getBotInfo).toBe('function')
  })
})

describe('buildOutboundContextLine', () => {
  it('falls back to "session #<id>" (never the literal "user") when the presence cache misses for a DM', () => {
    // Reproduces the bug: outbound private message lands while state.clients
    // is still empty (initial get_status ack window). recipientName is null,
    // and the line must surface the session id so it stays informative.
    const lineFr = buildOutboundContextLine({
      mode: 'text-private',
      locale: 'fr',
      channelName: 'whatever',
      voice: null,
      recipientName: null,
      recipientSessionId: 42,
    })
    expect(lineFr).toContain('session #42')
    expect(lineFr).not.toMatch(/\buser\b/)

    const lineEn = buildOutboundContextLine({
      mode: 'text-private',
      locale: 'en',
      channelName: 'whatever',
      voice: null,
      recipientName: null,
      recipientSessionId: 42,
    })
    expect(lineEn).toContain('session #42')
    expect(lineEn).not.toMatch(/\buser\b/)
  })

  it('uses the resolved recipient name when the cache hit succeeds', () => {
    const line = buildOutboundContextLine({
      mode: 'text-private',
      locale: 'en',
      channelName: 'whatever',
      voice: null,
      recipientName: 'Nicolas',
      recipientSessionId: 42,
    })
    expect(line).toContain('Nicolas')
    expect(line).not.toContain('session #')
  })

  it('renders the TTS voice when set in public mode', () => {
    const line = buildOutboundContextLine({
      mode: 'tts',
      locale: 'fr',
      channelName: 'Gaming',
      voice: 'Kartal',
      recipientName: null,
      recipientSessionId: null,
    })
    expect(line).toContain('Gaming')
    expect(line).toContain('Kartal')
  })
})

describe('normalizeUid', () => {
  it('passes strings through unchanged', () => {
    expect(normalizeUid('abc=')).toBe('abc=')
  })
  it('converts byte arrays to base64', () => {
    // "Hi" → 0x48 0x69 → "SGk="
    expect(normalizeUid([0x48, 0x69])).toBe('SGk=')
  })
  it('handles null/undefined safely', () => {
    expect(normalizeUid(null)).toBe('')
    expect(normalizeUid(undefined)).toBe('')
  })
})
