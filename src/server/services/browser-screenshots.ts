import { createFileFromContent } from '@/server/services/file-storage'
import type { ToolExecutionContext } from '@/server/tools/types'

/** Browser captures are attachments in private sessions, never public share links. */
export async function storeBrowserScreenshot(ctx: ToolExecutionContext, name: string, buffer: Buffer, sourceUrl: string) {
  if (ctx.sessionId) {
    if (!ctx.userId) throw new Error('User identity is required for a private screenshot')
    const { uploadFile } = await import('@/server/services/files')
    return uploadFile({
      agentId: ctx.agentId, uploadedBy: ctx.userId, sessionId: ctx.sessionId,
      file: new File([new Uint8Array(buffer)], `${name}.png`, { type: 'image/png' }),
    })
  }
  return createFileFromContent(ctx.agentId, name, buffer.toString('base64'), 'image/png', {
    isBase64: true, description: `Screenshot of ${sourceUrl}`, isPublic: true, createdByAgentId: ctx.agentId,
  })
}
