import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { sqlite } from '@/server/db/index'
import { db } from '@/server/db/index'
import { eq, asc, desc } from 'drizzle-orm'
import { compactingSummaries } from '@/server/db/schema'
import { createLogger } from '@/server/logger'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:history')

/**
 * search_history — keyword search across message history for a Kin.
 * Uses FTS5 keyword search with optional date range filtering and pagination.
 */
export const searchHistoryTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Keyword search in your message history. Optional date range + pagination. Returns totalCount. Result content is truncated to 500 chars — use read_message(id) for the full text or the surrounding conversation.',
      inputSchema: z.object({
        query: z.string().describe('Search keywords'),
        startDate: z.string().optional().describe('ISO date string for range start (e.g. "2026-01-15")'),
        endDate: z.string().optional().describe('ISO date string for range end (e.g. "2026-03-20")'),
        limit: z.number().int().min(1).max(30).optional().describe('Max results to return. Default: 10'),
        offset: z.number().int().min(0).optional().describe('Skip this many results for pagination. Default: 0'),
      }),
      execute: async ({ query, startDate, endDate, limit, offset }) => {
        log.debug({ kinId: ctx.kinId, query, startDate, endDate }, 'History search invoked')
        const maxResults = limit ?? 10
        const skip = offset ?? 0

        try {
          // Escape FTS5 special characters
          const ftsQuery = query
            .replace(/['"*()]/g, ' ')
            .split(/\s+/)
            .filter(Boolean)
            .map((term) => `"${term}"`)
            .join(' OR ')

          if (!ftsQuery) return { messages: [], totalCount: 0 }

          // Build date filter clause
          let dateFilter = ''
          const params: (string | number)[] = [ftsQuery, ctx.kinId]

          if (startDate) {
            dateFilter += ' AND m.created_at >= ?'
            params.push(new Date(startDate).getTime())
          }
          if (endDate) {
            dateFilter += ' AND m.created_at <= ?'
            params.push(new Date(endDate).getTime())
          }

          // Get total count first
          const countResult = sqlite
            .query<{ cnt: number }, (string | number)[]>(
              `SELECT COUNT(*) as cnt
               FROM messages_fts fts
               JOIN messages m ON m.rowid = fts.rowid
               WHERE messages_fts MATCH ? AND m.kin_id = ? AND m.is_redacted = 0${dateFilter}`,
            )
            .get(...params)

          const totalCount = countResult?.cnt ?? 0

          // Get paginated results
          const rows = sqlite
            .query<
              { id: string; role: string; content: string; source_type: string; created_at: number },
              (string | number)[]
            >(
              `SELECT m.id, m.role, m.content, m.source_type, m.created_at
               FROM messages_fts fts
               JOIN messages m ON m.rowid = fts.rowid
               WHERE messages_fts MATCH ? AND m.kin_id = ? AND m.is_redacted = 0${dateFilter}
               ORDER BY fts.rank
               LIMIT ? OFFSET ?`,
            )
            .all(...params, maxResults, skip)

          return {
            totalCount,
            messages: rows.map((r) => ({
              id: r.id,
              role: r.role,
              content: r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content,
              sourceType: r.source_type,
              createdAt: r.created_at,
            })),
          }
        } catch {
          return { messages: [], totalCount: 0, error: 'Search failed' }
        }
      },
    }),
}

/**
 * browse_history — view messages from a specific time period with pagination.
 */
export const browseHistoryTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Browse message history for a time range. Chronological order with pagination. totalCount = messages in range.',
      inputSchema: z.object({
        startDate: z.string().describe('ISO date string for range start (e.g. "2026-01-15")'),
        endDate: z.string().describe('ISO date string for range end (e.g. "2026-03-20")'),
        limit: z.number().int().min(1).max(50).optional().describe('Max messages to return. Default: 20'),
        offset: z.number().int().min(0).optional().describe('Skip this many messages for pagination. Default: 0'),
      }),
      execute: async ({ startDate, endDate, limit, offset }) => {
        log.debug({ kinId: ctx.kinId, startDate, endDate }, 'History browse invoked')
        const maxResults = limit ?? 20
        const skip = offset ?? 0

        try {
          const startMs = new Date(startDate).getTime()
          const endMs = new Date(endDate).getTime()

          // Get total count
          const countResult = sqlite
            .query<{ cnt: number }, [string, number, number]>(
              `SELECT COUNT(*) as cnt
               FROM messages
               WHERE kin_id = ? AND created_at >= ? AND created_at <= ?
                 AND is_redacted = 0 AND task_id IS NULL AND session_id IS NULL
                 AND source_type != 'compacting'`,
            )
            .get(ctx.kinId, startMs, endMs)

          const totalCount = countResult?.cnt ?? 0

          // Get paginated results in chronological order
          const rows = sqlite
            .query<
              { id: string; role: string; content: string; source_type: string; source_id: string | null; created_at: number },
              [string, number, number, number, number]
            >(
              `SELECT id, role, content, source_type, source_id, created_at
               FROM messages
               WHERE kin_id = ? AND created_at >= ? AND created_at <= ?
                 AND is_redacted = 0 AND task_id IS NULL AND session_id IS NULL
                 AND source_type != 'compacting'
               ORDER BY created_at ASC
               LIMIT ? OFFSET ?`,
            )
            .all(ctx.kinId, startMs, endMs, maxResults, skip)

          return {
            totalCount,
            showing: { from: skip + 1, to: skip + rows.length },
            messages: rows.map((r) => ({
              id: r.id,
              role: r.role,
              content: r.content.length > 500 ? r.content.slice(0, 500) + '...' : r.content,
              sourceType: r.source_type,
              createdAt: r.created_at,
            })),
          }
        } catch {
          return { messages: [], totalCount: 0, error: 'Browse failed' }
        }
      },
    }),
}

/**
 * read_message — read the FULL text of a single message by ID, optionally with a
 * window of surrounding messages (anchored view). Complements search_history,
 * whose hits are truncated to 500 chars and carry no surrounding context.
 */
export const readMessageTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Read the FULL text of a message by its ID (search_history truncates results to 500 chars). Optionally include the surrounding messages from the same conversation for context (anchored view).',
      inputSchema: z.object({
        messageId: z.string().describe('The message ID, e.g. from a search_history result'),
        contextBefore: z.number().int().min(0).max(20).optional().describe('Include this many preceding messages from the same conversation. Default: 0'),
        contextAfter: z.number().int().min(0).max(20).optional().describe('Include this many following messages from the same conversation. Default: 0'),
      }),
      execute: async ({ messageId, contextBefore, contextAfter }) => {
        const before = contextBefore ?? 0
        const after = contextAfter ?? 0
        log.debug({ kinId: ctx.kinId, messageId, before, after }, 'Read message invoked')

        try {
          const target = sqlite
            .query<
              { rowid: number; id: string; role: string; content: string | null; source_type: string; task_id: string | null; session_id: string | null; created_at: number; is_redacted: number; kin_id: string },
              [string]
            >(
              `SELECT rowid, id, role, content, source_type, task_id, session_id, created_at, is_redacted, kin_id
               FROM messages WHERE id = ?`,
            )
            .get(messageId)

          if (!target || target.kin_id !== ctx.kinId) return { error: 'Message not found' }
          if (target.is_redacted) return { error: 'Message is redacted and cannot be read' }

          const full = (r: { id: string; role: string; content: string | null; source_type: string; created_at: number }) => ({
            id: r.id,
            role: r.role,
            content: r.content ?? '',
            sourceType: r.source_type,
            createdAt: r.created_at,
          })
          // Surrounding messages are truncated (read_message them individually
          // for full text) so an anchored window stays a bounded payload.
          const windowed = (r: { id: string; role: string; content: string | null; source_type: string; created_at: number }) => {
            const c = r.content ?? ''
            return { ...full(r), content: c.length > 800 ? c.slice(0, 800) + '...' : c }
          }

          const result: {
            message: ReturnType<typeof full>
            context?: { before: ReturnType<typeof windowed>[]; after: ReturnType<typeof windowed>[] }
          } = { message: full(target) }

          if (before > 0 || after > 0) {
            // Anchor the window to the SAME conversation stream as the target
            // (kin + matching task_id/session_id bucket), ordered by rowid
            // (monotonic = chronological). Redacted + compaction rows excluded.
            const taskClause = target.task_id === null ? 'task_id IS NULL' : 'task_id = ?'
            const sessionClause = target.session_id === null ? 'session_id IS NULL' : 'session_id = ?'
            const bucket: (string | number)[] = []
            if (target.task_id !== null) bucket.push(target.task_id)
            if (target.session_id !== null) bucket.push(target.session_id)

            const cols = 'rowid, id, role, content, source_type, created_at'
            const where = `kin_id = ? AND is_redacted = 0 AND source_type != 'compacting' AND ${taskClause} AND ${sessionClause}`

            const beforeRows = before > 0
              ? sqlite
                  .query<{ id: string; role: string; content: string | null; source_type: string; created_at: number }, (string | number)[]>(
                    `SELECT ${cols} FROM messages WHERE ${where} AND rowid < ? ORDER BY rowid DESC LIMIT ?`,
                  )
                  .all(ctx.kinId, ...bucket, target.rowid, before)
                  .reverse()
              : []

            const afterRows = after > 0
              ? sqlite
                  .query<{ id: string; role: string; content: string | null; source_type: string; created_at: number }, (string | number)[]>(
                    `SELECT ${cols} FROM messages WHERE ${where} AND rowid > ? ORDER BY rowid ASC LIMIT ?`,
                  )
                  .all(ctx.kinId, ...bucket, target.rowid, after)
              : []

            result.context = { before: beforeRows.map(windowed), after: afterRows.map(windowed) }
          }

          return result
        } catch {
          return { error: 'Failed to read message' }
        }
      },
    }),
}

/**
 * list_summaries — list all compacting summaries (in-context and archived) with metadata.
 */
export const listSummariesTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'List all conversation summaries (active in context + archived). Shows date range, depth, in-context status. Use read_summary for full text.',
      inputSchema: z.object({
        includeArchived: z.boolean().optional().describe('Include archived/merged summaries. Default: false'),
      }),
      execute: async ({ includeArchived }) => {
        log.debug({ kinId: ctx.kinId, includeArchived }, 'List summaries invoked')

        try {
          let query = db
            .select({
              id: compactingSummaries.id,
              firstMessageAt: compactingSummaries.firstMessageAt,
              lastMessageAt: compactingSummaries.lastMessageAt,
              messageCount: compactingSummaries.messageCount,
              tokenEstimate: compactingSummaries.tokenEstimate,
              isInContext: compactingSummaries.isInContext,
              depth: compactingSummaries.depth,
              createdAt: compactingSummaries.createdAt,
            })
            .from(compactingSummaries)
            .where(eq(compactingSummaries.kinId, ctx.kinId))
            .orderBy(asc(compactingSummaries.lastMessageAt))

          const allSummaries = await query.all()

          const filtered = includeArchived
            ? allSummaries
            : allSummaries.filter((s) => s.isInContext)

          return {
            totalCount: filtered.length,
            summaries: filtered.map((s) => ({
              id: s.id,
              firstMessageAt: s.firstMessageAt.toISOString(),
              lastMessageAt: s.lastMessageAt.toISOString(),
              messageCount: s.messageCount,
              tokenEstimate: s.tokenEstimate,
              isInContext: s.isInContext,
              depth: s.depth,
              depthLabel: (s.depth ?? 0) === 0 ? 'detailed' : 'compressed',
              createdAt: s.createdAt.toISOString(),
            })),
          }
        } catch {
          return { summaries: [], totalCount: 0, error: 'Failed to list summaries' }
        }
      },
    }),
}

/**
 * read_summary — read the full text of a specific summary by ID.
 */
export const readSummaryTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Read the full text of a conversation summary by its ID. Use list_summaries first to find available summary IDs.',
      inputSchema: z.object({
        summaryId: z.string().describe('The ID of the summary to read'),
      }),
      execute: async ({ summaryId }) => {
        log.debug({ kinId: ctx.kinId, summaryId }, 'Read summary invoked')

        try {
          const summary = await db
            .select()
            .from(compactingSummaries)
            .where(eq(compactingSummaries.id, summaryId))
            .get()

          if (!summary) {
            return { error: 'Summary not found' }
          }

          if (summary.kinId !== ctx.kinId) {
            return { error: 'Summary belongs to another Kin' }
          }

          return {
            id: summary.id,
            summary: summary.summary,
            firstMessageAt: summary.firstMessageAt.toISOString(),
            lastMessageAt: summary.lastMessageAt.toISOString(),
            messageCount: summary.messageCount,
            isInContext: summary.isInContext,
            depth: summary.depth,
            depthLabel: (summary.depth ?? 0) === 0 ? 'detailed' : 'compressed',
          }
        } catch {
          return { error: 'Failed to read summary' }
        }
      },
    }),
}
