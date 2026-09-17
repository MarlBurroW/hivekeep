import { Hono } from 'hono'
import { logStore } from '@/server/services/log-store'
import type { AppVariables } from '@/server/app'
import { requireAdmin } from '@/server/auth/require-admin'

export const logRoutes = new Hono<{ Variables: AppVariables }>()

// Platform configuration: every route in this family is admin-only.
logRoutes.use('*', requireAdmin)

logRoutes.get('/', (c) => {
  const level = c.req.query('level') || undefined
  const module = c.req.query('module') || undefined
  const search = c.req.query('search') || undefined
  const minutesAgo = c.req.query('minutesAgo')
    ? Number(c.req.query('minutesAgo'))
    : undefined
  const limit = Math.min(Number(c.req.query('limit') || 200), 200)

  const logs = logStore.query({ level, module, search, minutesAgo, limit })
  return c.json({ logs })
})

logRoutes.get('/modules', (c) => {
  return c.json({ modules: logStore.getModules() })
})
