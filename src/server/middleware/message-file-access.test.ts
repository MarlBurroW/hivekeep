import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { Hono } from 'hono'
import { fullMockSchema } from '../../test-helpers'

let file: Record<string, unknown> | null
let message: { sessionId: string | null } | null
let owner: { createdBy: string } | null
const fileId = '12345678-1234-1234-1234-123456789abc'
const filename = `${fileId}.png`

mock.module('@/server/db', () => ({
  db: { select: () => ({ from: (table: unknown) => ({ where: () => ({
    get: () => table === fullMockSchema.files ? file : table === fullMockSchema.messages ? message : owner,
    all: () => file ? [file] : [],
  }) }) }) },
}))
mock.module('@/server/db/schema', () => fullMockSchema)
const { requireMessageFileAccess } = await import('./message-file-access')
const { canAttachFiles } = await import('../services/file-attachments')

function app(userId = 'alice') {
  const server = new Hono<{ Variables: { user: { id: string } } }>()
  server.use('*', async (c, next) => { c.set('user', { id: userId }); return next() })
  server.use('/api/uploads/*', requireMessageFileAccess as never)
  server.get('*', (c) => c.text('attachment'))
  return server
}
const url = `/api/uploads/messages/agent/${filename}`
beforeEach(() => {
  file = { id: fileId, agentId: 'agent', storedPath: `/tmp/uploads/${filename}`, uploadedBy: 'alice', messageId: null, sessionId: null }
  message = null
  owner = { createdBy: 'alice' }
})

describe('attachment access', () => {
  it('keeps unsent drafts visible only to their author', async () => {
    expect((await app().request(url)).status).toBe(200)
    expect((await app('bob').request(url)).status).toBe(404)
    expect((await app().request(url)).headers.get('Cache-Control')).toBe('private, no-store')
  })
  it('keeps generated private artifacts private without a message anchor', async () => {
    file = { ...file, uploadedBy: null, sessionId: 'private' }
    expect((await app().request(url)).status).toBe(200)
    expect((await app('bob').request(url)).status).toBe(404)
    owner = null
    expect((await app().request(url)).status).toBe(404)
  })
  it('recognizes legacy private attachments through the linked message', async () => {
    file = { ...file, messageId: 'message' }
    message = { sessionId: 'private' }
    expect((await app('bob').request(url)).status).toBe(404)
    message = { sessionId: null }
    expect((await app('bob').request(url)).status).toBe(200)
  })
  it('does not bypass checks with an encoded uploads category or wrong filename', async () => {
    expect((await app('bob').request(url.replace('/messages/', '/%6dessages/'))).status).toBe(404)
    expect((await app().request(url.replace('.png', '.pdf'))).status).toBe(404)
  })
  it('prevents relinking a private, already-sent or another user’s attachment', () => {
    expect(canAttachFiles([fileId], 'alice', 'agent')).toBe(true)
    expect(canAttachFiles([fileId], 'bob', 'agent')).toBe(false)
    file = { ...file, sessionId: 'private' }
    expect(canAttachFiles([fileId], 'alice', 'agent')).toBe(false)
    expect(canAttachFiles([fileId], 'alice', 'agent', 'private')).toBe(true)
    file = { ...file, messageId: 'already-sent' }
    expect(canAttachFiles([fileId], 'alice', 'agent', 'private')).toBe(false)
  })
})
