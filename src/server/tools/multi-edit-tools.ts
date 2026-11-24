import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { resolve, extname, basename } from 'path'
import { existsSync } from 'fs'
import { readFile, writeFile } from 'fs/promises'
import { createLogger } from '@/server/logger'
import { resolveAndValidate } from '@/server/tools/filesystem-tools'
import { hasReadPath, recordGuardFire } from '@/server/services/tool-call-tracker'
import type { ToolRegistration } from '@/server/tools/types'
import { resolveToolWorkspace } from '@/server/tools/workspace'
import { emitWorkspaceChangedForTool } from '@/server/services/workspace-files'

const log = createLogger('multi-edit-tools')

const EXTENSION_LANGUAGES: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift', '.cs': 'csharp',
  '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.hpp': 'cpp',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.md': 'markdown', '.sql': 'sql', '.sh': 'bash',
}

function detectLanguage(filePath: string): string | undefined {
  const ext = extname(filePath).toLowerCase()
  if (EXTENSION_LANGUAGES[ext]) return EXTENSION_LANGUAGES[ext]
  const name = basename(filePath).toLowerCase()
  if (name === 'dockerfile') return 'dockerfile'
  if (name === 'makefile') return 'makefile'
  return undefined
}

// ── multi_edit ────────────────────────────────────────────

export const multiEditTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  expandsSecrets: true,
  create: (ctx) =>
    tool({
      description:
        'Atomic multi-edit on a single file: all replacements succeed or none apply. Edits run sequentially (each sees the previous result). Use instead of repeated edit_file on the same file. **You must `read_file` this path at least once earlier in the task** — edits without a prior read are refused (prevents hallucinated edits).',
      inputSchema: z.object({
        path: z.string().describe('Relative to workspace or absolute'),
        edits: z
          .array(
            z.object({
              oldText: z.string().min(1).describe('Exact text to find (must match once)'),
              newText: z.string().describe('Replacement text'),
            }),
          )
          .min(1)
          .max(50)
          .describe('Ordered list of edits. Each oldText must match exactly once in the content at that point.'),
      }),
      execute: async ({ path: filePath, edits }) => {
        const workspace = resolveToolWorkspace(ctx)
        const absPath = resolveAndValidate(filePath, workspace)

        if (!hasReadPath(ctx.taskId, filePath)) {
          recordGuardFire(ctx.taskId, 'readBeforeEditRefusal')
          return {
            success: false,
            error: `Refusing to multi-edit \`${filePath}\` — you have not read this file in this task yet. Call read_file first, then retry the edits. This guard prevents hallucinated edits based on assumed content.`,
            path: filePath,
          }
        }

        try {
          if (!existsSync(absPath)) {
            return { success: false, error: `File not found: ${filePath}` }
          }

          const buf = await readFile(absPath)
          const originalContent = buf.toString('utf-8')
          let content = originalContent

          // Apply edits sequentially in memory
          for (let i = 0; i < edits.length; i++) {
            const { oldText, newText } = edits[i]!
            const occurrences = content.split(oldText).length - 1

            if (occurrences === 0) {
              return {
                success: false,
                error: `Edit #${i + 1}: oldText not found in file. Make sure it matches exactly (including whitespace and newlines).`,
                failedEditIndex: i,
                editsAppliedBeforeFailure: i,
                path: filePath,
              }
            }

            if (occurrences > 1) {
              return {
                success: false,
                error: `Edit #${i + 1}: oldText matches ${occurrences} locations. It must match exactly once. Use a larger context to disambiguate.`,
                failedEditIndex: i,
                editsAppliedBeforeFailure: i,
                path: filePath,
              }
            }

            content = content.replace(oldText, () => newText)
          }

          // All edits succeeded — write once
          await writeFile(absPath, content, 'utf-8')
          emitWorkspaceChangedForTool(ctx, absPath, 'modified')

          const language = detectLanguage(absPath)

          log.info(
            { agentId: ctx.agentId, path: filePath, editsApplied: edits.length },
            'Multi-edit applied',
          )

          return {
            success: true,
            path: filePath,
            editsApplied: edits.length,
            language: language ?? null,
          }
        } catch (err: any) {
          return { success: false, error: err.message }
        }
      },
    }),
}
