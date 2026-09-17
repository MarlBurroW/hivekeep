import { Hono } from 'hono'
import { respondToSecretPrompt, cancelSecretPrompt, getPendingSecretPrompts } from '@/server/services/secret-prompts'
import type { AppVariables } from '@/server/app'
import { requireAdmin } from '@/server/auth/require-admin'

export const secretPromptRoutes = new Hono<{ Variables: AppVariables }>()

// Platform configuration: every route in this family is admin-only.
secretPromptRoutes.use('*', requireAdmin)

/**
 * POST /api/secret-prompts/:id/respond — submit the secret value(s) for a
 * pending secure-input prompt. The body never touches the LLM; the server
 * stores it in the vault and performs the side effect (create+test provider,
 * store secret). Body: { values: Record<fieldKey, string> }.
 */
secretPromptRoutes.post('/:id/respond', async (c) => {
  const promptId = c.req.param('id')
  const body = await c.req.json<{ values?: Record<string, string> }>().catch(() => null)
  if (!body || typeof body.values !== 'object' || body.values === null) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'A `values` object is required' } }, 400)
  }

  const user = c.get('user')
  const result = await respondToSecretPrompt(promptId, body.values, user.id)
  if (!result.success) {
    return c.json({ error: { code: 'SECRET_PROMPT_ERROR', message: result.error } }, 400)
  }
  return c.json({ success: true, summary: result.summary })
})

/**
 * POST /api/secret-prompts/:id/cancel — dismiss a pending secure-input prompt
 * without providing the value. Takes it out of `pending` (so it stops re-firing
 * on every reload) and resumes the Agent with a neutral "declined" note.
 */
secretPromptRoutes.post('/:id/cancel', async (c) => {
  const promptId = c.req.param('id')
  const user = c.get('user')
  const result = await cancelSecretPrompt(promptId, user.id)
  if (!result.success) {
    return c.json({ error: { code: 'SECRET_PROMPT_ERROR', message: result.error } }, 400)
  }
  return c.json({ success: true })
})

/**
 * GET /api/secret-prompts/pending?agentId=... — pending secure-input prompts for
 * hydration on page load / modal reconnect. Returns field metadata only (never
 * secret values).
 */
secretPromptRoutes.get('/pending', async (c) => {
  const agentId = c.req.query('agentId')
  if (!agentId) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'agentId is required' } }, 400)
  }
  const prompts = await getPendingSecretPrompts(agentId)
  return c.json({ prompts })
})
