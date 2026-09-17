import { Hono } from 'hono'
import { db } from '@/server/db'
import { eq } from 'drizzle-orm'
import { quickSessions } from '@/server/db/schema'
import { uploadFile } from '@/server/services/files'
import type { AppVariables } from '@/server/app'
import { createLogger } from '@/server/logger'

const log = createLogger('routes:files')

export const fileRoutes = new Hono<{ Variables: AppVariables }>()

// POST /api/files/upload — upload a file
fileRoutes.post('/upload', async (c) => {
  const user = c.get('user') as { id: string; name: string }

  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  const agentId = formData.get('agentId') as string | null
  const sessionId = formData.get('sessionId')
  if (sessionId) {
    if (typeof sessionId !== 'string') return c.notFound()
    const session = db.select().from(quickSessions).where(eq(quickSessions.id, sessionId)).get()
    if (!session || session.createdBy !== user.id || session.agentId !== agentId || session.status !== 'active') return c.notFound()
  }

  if (!file || !(file instanceof File)) {
    return c.json(
      { error: { code: 'INVALID_FILE', message: 'A file is required' } },
      400,
    )
  }

  if (!agentId) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'agentId is required' } },
      400,
    )
  }

  try {
    const result = await uploadFile({
      agentId,
      uploadedBy: user.id,
      sessionId: typeof sessionId === 'string' ? sessionId : undefined,
      file,
    })

    log.info({ fileId: result.id, agentId, fileName: file.name, size: file.size }, 'File uploaded')
    return c.json({ file: result }, 201)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Upload failed'
    const code = message.includes('too large') ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR'
    return c.json({ error: { code, message } }, 400)
  }
})
