import { z } from 'zod'
import { tool } from '@/server/tools/tool-helper'
import { createLogger } from '@/server/logger'
import {
  createMiniApp,
  getMiniApp,
  listAllMiniApps,
  setMiniAppMaintainer,
  updateMiniApp,
  deleteMiniApp,
  writeAppFile,
  readAppFile,
  deleteAppFile,
  listAppFiles,
  getMiniAppRow,
  storageGet,
  storageSet,
  storageDelete,
  storageList,
  storageClear,
  createSnapshot,
  listSnapshots,
  rollbackToSnapshot,
  generateMiniAppIcon,
} from '@/server/services/mini-apps'
import { ImageGenerationError } from '@/server/services/image-generation'
import { getConsoleEntries, clearConsoleEntries, getServedAt } from '@/server/services/mini-app-console'
import {
  buildDefaultManifest,
  findBareModuleImports,
  htmlHasInlineImportMap,
  mergeDependenciesIntoManifest,
} from '@/server/services/mini-app-deps'
import { getTemplateById } from '@/server/tools/mini-app-templates'
import { sseManager } from '@/server/sse/index'
import { resolveAgentId } from '@/server/services/agent-resolver'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:mini-apps')

// ─── create_mini_app ────────────────────────────────────────────────────────

export const createMiniAppTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Create a new mini web app displayed in the Hivekeep sidebar. ' +
        'Call get_mini_app_docs first for full SDK reference. ' +
        'Use get_mini_app_templates to start from a template. ' +
        'Apps can have a _server.js backend; with "background": true in app.json it runs as a live ' +
        'service (boot-loaded, onStart/onStop, local cron jobs via ctx.schedule, platform notifications ' +
        'via ctx.notify, and permission-gated access to vault secrets / LLM / you via app.json "permissions"). ' +
        'Bare ES imports (react, @hivekeep/react, …) resolve ONLY via an app.json import map, ' +
        'never via inline HTML tags — pass `dependencies` (shorthand import map) or a `files` ' +
        'map that includes app.json so the app works in a single call. If you provide HTML with ' +
        'bare imports but no app.json/dependencies, a default app.json (react stack) is created ' +
        'automatically and reported back as a warning.',
      inputSchema: z.object({
        name: z.string().describe('Display name'),
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/).describe('Unique kebab-case identifier'),
        description: z.string().optional(),
        icon: z.string().optional().describe('Single emoji'),
        html: z.string().optional().describe('HTML for index.html (one of html, files, or template required)'),
        template: z.string().optional().describe('Template name instead of html'),
        files: z
          .record(z.string(), z.string())
          .optional()
          .describe('Map of relative path → file content, e.g. { "index.html": "...", "app.json": "...", "_server.js": "..." }. Created in one call. Takes precedence over `html`.'),
        dependencies: z
          .record(z.string(), z.string())
          .optional()
          .describe('Import-map shorthand, e.g. { "react": "https://esm.sh/react@19" }. Written into app.json (merged if app.json is also provided).'),
      }),
      execute: async ({ name, slug, description, icon, html, template, files, dependencies }) => {
        log.debug({ agentId: ctx.agentId, name, slug }, 'create_mini_app invoked')

        try {
          // Resolve template if specified
          let templateData: ReturnType<typeof getTemplateById> | undefined
          if (template) {
            templateData = getTemplateById(template)
            if (!templateData) {
              return { error: `Template "${template}" not found. Use get_mini_app_templates to see available templates.` }
            }
          }

          // Assemble the file set in memory (precedence: template > files > html).
          let fileset: Record<string, string> = {}
          let warning: string | undefined

          if (templateData) {
            fileset = { ...templateData.files }
          } else {
            if (files) fileset = { ...files }
            if (html && fileset['index.html'] === undefined) fileset['index.html'] = html

            if (Object.keys(fileset).length === 0) {
              return { error: 'One of html, files, or template is required' }
            }

            // Merge `dependencies` shorthand into app.json (create it if absent).
            if (dependencies && Object.keys(dependencies).length > 0) {
              fileset['app.json'] = mergeDependenciesIntoManifest(fileset['app.json'], dependencies)
            }

            // Auto-default: HTML uses bare ES imports but nothing resolves them → inject a
            // default app.json so the app works, and report what we did.
            const entryHtml = fileset['index.html']
            const hasManifest = fileset['app.json'] !== undefined
            if (
              entryHtml !== undefined &&
              !hasManifest &&
              !htmlHasInlineImportMap(entryHtml) &&
              findBareModuleImports(entryHtml).length > 0
            ) {
              fileset['app.json'] = buildDefaultManifest()
              warning =
                'No app.json or import map was provided, but your HTML imports bare ES modules. ' +
                'A default app.json was created with: react, react-dom/client, @hivekeep/react, ' +
                '@hivekeep/components. Edit it via write_mini_app_file if you need different ' +
                "versions. See get_mini_app_docs('getting-started')."
            }
          }

          const app = await createMiniApp({
            agentId: ctx.agentId,
            name,
            slug,
            description,
            icon: icon || templateData?.icon,
          })

          for (const [filePath, content] of Object.entries(fileset)) {
            await writeAppFile(app.id, filePath, content)
          }

          // Re-fetch to get updated version
          const updated = await getMiniApp(app.id)
          sseManager.broadcast({ type: 'miniapp:created', agentId: ctx.agentId, data: { app: updated } })

          return {
            appId: app.id,
            name: app.name,
            slug: app.slug,
            template: template || undefined,
            warning,
            message: `App "${name}" created successfully${template ? ` from template "${template}"` : ''}. It is now visible in the sidebar.`,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to create app'
          log.warn({ agentId: ctx.agentId, name, error: message }, 'create_mini_app failed')
          return { error: message }
        }
      },
    }),
}

// ─── update_mini_app ────────────────────────────────────────────────────────

export const updateMiniAppTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Update mini app metadata (name, description, icon, active status).',
      inputSchema: z.object({
        app_id: z.string(),
        name: z.string().optional(),
        description: z.string().nullable().optional(),
        icon: z.string().nullable().optional(),
        entry_file: z.string().optional(),
        is_active: z.boolean().optional(),
      }),
      execute: async (args) => {
        log.debug({ agentId: ctx.agentId, appId: args.app_id }, 'update_mini_app invoked')

        const existing = await getMiniApp(args.app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const app = await updateMiniApp(args.app_id, {
            name: args.name,
            description: args.description,
            icon: args.icon,
            entryFile: args.entry_file,
            isActive: args.is_active,
          })

          sseManager.broadcast({ type: 'miniapp:updated', agentId: ctx.agentId, data: { app } })
          return { appId: args.app_id, message: 'App updated successfully' }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to update app'
          return { error: message }
        }
      },
    }),
}

// ─── delete_mini_app ────────────────────────────────────────────────────────

export const deleteMiniAppTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Delete a mini app and all its files permanently.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id }, 'delete_mini_app invoked')

        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        await deleteMiniApp(app_id)
        sseManager.broadcast({ type: 'miniapp:deleted', agentId: ctx.agentId, data: { appId: app_id } })

        return { message: `App "${existing.name}" deleted successfully` }
      },
    }),
}

// ─── list_mini_apps ─────────────────────────────────────────────────────────

export const listMiniAppsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List ALL mini apps (not just ones you maintain). You can edit any of them; `maintainerAgentId`/`maintainerAgentName` show who is responsible and `maintainedByYou` whether that is you.',
      inputSchema: z.object({}),
      execute: async () => {
        const apps = await listAllMiniApps()
        return {
          apps: apps.map((a) => ({
            id: a.id,
            name: a.name,
            slug: a.slug,
            description: a.description,
            icon: a.icon,
            isActive: a.isActive,
            hasBackend: a.hasBackend,
            version: a.version,
            maintainerAgentId: a.maintainerAgentId,
            maintainerAgentName: a.maintainerAgentName,
            maintainedByYou: a.maintainerAgentId === ctx.agentId,
          })),
        }
      },
    }),
}

// ─── write_mini_app_file ────────────────────────────────────────────────────

export const writeMiniAppFileTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Write or overwrite a file in a mini app. App reloads automatically after write.',
      inputSchema: z.object({
        app_id: z.string(),
        path: z.string().describe('Relative file path (e.g. "styles.css", "_server.js")'),
        content: z.string(),
        is_base64: z.boolean().optional().describe('True if content is base64-encoded'),
      }),
      execute: async ({ app_id, path, content, is_base64 }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id, path }, 'write_mini_app_file invoked')

        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const buffer = is_base64 ? Buffer.from(content, 'base64') : content
          const result = await writeAppFile(app_id, path, buffer)

          const row = await getMiniAppRow(app_id)
          if (row) {
            sseManager.broadcast({
              type: 'miniapp:file-updated',
              agentId: ctx.agentId,
              data: { appId: app_id, path, version: row.version },
            })
          }

          return { success: true, path: result.path, size: result.size }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to write file'
          return { error: message }
        }
      },
    }),
}

// ─── read_mini_app_file ─────────────────────────────────────────────────────

export const readMiniAppFileTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'Read a file from a mini app. Returns text or base64 for binary files.',
      inputSchema: z.object({
        app_id: z.string(),
        path: z.string(),
      }),
      execute: async ({ app_id, path }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const buffer = await readAppFile(app_id, path)
          // Determine if text or binary
          const textExtensions = new Set(['html', 'htm', 'css', 'js', 'ts', 'json', 'svg', 'txt', 'md', 'xml'])
          const ext = path.split('.').pop()?.toLowerCase() ?? ''
          if (textExtensions.has(ext)) {
            return { path, content: buffer.toString('utf-8') }
          }
          return { path, content: buffer.toString('base64'), isBase64: true }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to read file'
          return { error: message }
        }
      },
    }),
}

// ─── delete_mini_app_file ───────────────────────────────────────────────────

export const deleteMiniAppFileTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Delete a file from a mini app.',
      inputSchema: z.object({
        app_id: z.string(),
        path: z.string(),
      }),
      execute: async ({ app_id, path }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const deleted = await deleteAppFile(app_id, path)
          if (!deleted) return { error: 'File not found' }

          const row = await getMiniAppRow(app_id)
          if (row) {
            sseManager.broadcast({
              type: 'miniapp:file-updated',
              agentId: ctx.agentId,
              data: { appId: app_id, path, version: row.version },
            })
          }

          return { message: `File "${path}" deleted` }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to delete file'
          return { error: message }
        }
      },
    }),
}

// ─── list_mini_app_files ────────────────────────────────────────────────────

export const listMiniAppFilesTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List all files in a mini app with sizes and MIME types.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const files = await listAppFiles(app_id)
          return { files }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to list files'
          return { error: message }
        }
      },
    }),
}

// ─── get_mini_app_storage ───────────────────────────────────────────────────

export const getMiniAppStorageTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'Read a value from a mini app\'s key-value storage.',
      inputSchema: z.object({
        app_id: z.string(),
        key: z.string(),
      }),
      execute: async ({ app_id, key }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        const value = await storageGet(app_id, key)
        if (value === null) return { key, value: null, found: false }
        try {
          return { key, value: JSON.parse(value), found: true }
        } catch {
          return { key, value, found: true }
        }
      },
    }),
}

// ─── set_mini_app_storage ───────────────────────────────────────────────────

export const setMiniAppStorageTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Set a value in a mini app\'s key-value storage. Max 64KB per value.',
      inputSchema: z.object({
        app_id: z.string(),
        key: z.string(),
        value: z.any().describe('JSON-serializable value'),
      }),
      execute: async ({ app_id, key, value }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          await storageSet(app_id, key, JSON.stringify(value))
          return { key, message: `Storage key "${key}" set successfully` }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Storage error'
          return { error: message }
        }
      },
    }),
}

// ─── delete_mini_app_storage ────────────────────────────────────────────────

export const deleteMiniAppStorageTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Delete a key from a mini app\'s key-value storage.',
      inputSchema: z.object({
        app_id: z.string(),
        key: z.string(),
      }),
      execute: async ({ app_id, key }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        const deleted = await storageDelete(app_id, key)
        if (!deleted) return { key, deleted: false, message: 'Key not found' }
        return { key, deleted: true, message: `Storage key "${key}" deleted` }
      },
    }),
}

// ─── list_mini_app_storage ──────────────────────────────────────────────────

export const listMiniAppStorageTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List all storage keys for a mini app with their sizes.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const keys = await storageList(app_id)
          return { keys, count: keys.length }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Storage error'
          return { error: message }
        }
      },
    }),
}

// ─── clear_mini_app_storage ─────────────────────────────────────────────────

export const clearMiniAppStorageTool: ToolRegistration = {
  availability: ['main'],
  destructive: true,
  create: (ctx) =>
    tool({
      description: 'Clear all storage keys for a mini app. Removes all persisted data.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const cleared = await storageClear(app_id)
          return { cleared, message: `Cleared ${cleared} storage key(s)` }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Storage error'
          return { error: message }
        }
      },
    }),
}

// ─── create_mini_app_snapshot ───────────────────────────────────────────────

export const createMiniAppSnapshotTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Create a snapshot (backup) of a mini app. Restore later with rollback_mini_app. Max 20 per app.',
      inputSchema: z.object({
        app_id: z.string(),
        label: z.string().optional(),
      }),
      execute: async ({ app_id, label }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id }, 'create_mini_app_snapshot invoked')

        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const snapshot = await createSnapshot(app_id, label)
          if (!snapshot) return { error: 'No files to snapshot' }
          return {
            version: snapshot.version,
            label: snapshot.label,
            fileCount: snapshot.files.length,
            message: `Snapshot created at version ${snapshot.version}${label ? ` (${label})` : ''}`,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to create snapshot'
          return { error: message }
        }
      },
    }),
}

// ─── list_mini_app_snapshots ────────────────────────────────────────────────

export const listMiniAppSnapshotsTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description: 'List available snapshots for a mini app.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const snapshots = await listSnapshots(app_id)
          return {
            currentVersion: existing.version,
            snapshots: snapshots.map((s) => ({
              version: s.version,
              label: s.label,
              fileCount: s.files.length,
              files: s.files.map((f) => f.path),
              createdAt: new Date(s.createdAt).toISOString(),
            })),
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to list snapshots'
          return { error: message }
        }
      },
    }),
}

// ─── rollback_mini_app ──────────────────────────────────────────────────────

export const rollbackMiniAppTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description: 'Rollback a mini app to a previous snapshot. Auto-backs up current state first.',
      inputSchema: z.object({
        app_id: z.string(),
        version: z.number().int().positive().describe('Version from list_mini_app_snapshots'),
      }),
      execute: async ({ app_id, version }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id, version }, 'rollback_mini_app invoked')

        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const result = await rollbackToSnapshot(app_id, version)
          if (!result.success) return { error: result.message }

          // Broadcast update so UI refreshes
          const updated = await getMiniApp(app_id)
          if (updated) {
            sseManager.broadcast({
              type: 'miniapp:updated',
              agentId: ctx.agentId,
              data: { app: updated },
            })
          }

          return { message: result.message }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to rollback'
          return { error: message }
        }
      },
    }),
}

// ─── generate_mini_app_icon ──────────────────────────────────────────────────

export const generateMiniAppIconTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Generate an AI icon for a mini app. Requires image provider. ' +
        'May incur costs — ask user confirmation first.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id }, 'generate_mini_app_icon invoked')

        // Verify the app belongs to this agent
        const row = await getMiniAppRow(app_id)
        if (!row) {
          return { error: 'Mini-app not found or does not belong to this Agent' }
        }

        try {
          const app = await generateMiniAppIcon(app_id)
          sseManager.broadcast({ type: 'miniapp:updated', agentId: ctx.agentId, data: { app } })
          return {
            iconUrl: app.iconUrl,
            message: `Icon generated for "${app.name}". It is now visible in the sidebar and gallery.`,
          }
        } catch (err) {
          if (err instanceof ImageGenerationError && err.code === 'NO_IMAGE_PROVIDER') {
            return { error: 'No image generation provider is configured. The app will keep using its emoji icon.' }
          }
          const message = err instanceof Error ? err.message : 'Failed to generate icon'
          log.warn({ agentId: ctx.agentId, appId: app_id, error: message }, 'generate_mini_app_icon failed')
          return { error: message }
        }
      },
    }),
}

// ─── edit_mini_app_file ─────────────────────────────────────────────────────

export const editMiniAppFileTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Edit a mini app file by replacing exact text. By default oldText must match exactly once; set replaceAll=true to replace all occurrences. For multiple different edits, use multi_edit_mini_app_file instead.',
      inputSchema: z.object({
        app_id: z.string(),
        path: z.string().describe('Relative file path (e.g. "app.jsx")'),
        oldText: z.string().describe('Exact text to find (must match once)'),
        newText: z.string().describe('Replacement text'),
        replaceAll: z
          .boolean()
          .optional()
          .describe('If true, replace ALL occurrences of oldText. Default: false'),
      }),
      execute: async ({ app_id, path, oldText, newText, replaceAll }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id, path }, 'edit_mini_app_file invoked')

        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const buffer = await readAppFile(app_id, path)
          const content = buffer.toString('utf-8')

          // Count occurrences
          const occurrences = content.split(oldText).length - 1
          if (occurrences === 0) {
            return {
              success: false,
              error: 'oldText not found in file. Make sure it matches exactly (including whitespace and newlines).',
              path,
            }
          }
          if (!replaceAll && occurrences > 1) {
            return {
              success: false,
              error: `oldText matches ${occurrences} locations. It must match exactly once. Use a larger context to disambiguate, or set replaceAll=true to replace all occurrences.`,
              path,
            }
          }

          // Apply the edit(s)
          const newContent = replaceAll
            ? content.split(oldText).join(newText)
            : content.replace(oldText, newText)

          await writeAppFile(app_id, path, newContent)

          const row = await getMiniAppRow(app_id)
          if (row) {
            sseManager.broadcast({
              type: 'miniapp:file-updated',
              agentId: ctx.agentId,
              data: { appId: app_id, path, version: row.version },
            })
          }

          log.info(
            { agentId: ctx.agentId, appId: app_id, path, replacementCount: replaceAll ? occurrences : 1 },
            'Mini app file edited',
          )

          return {
            success: true,
            path,
            replacementCount: replaceAll ? occurrences : 1,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to edit file'
          return { error: message }
        }
      },
    }),
}

// ─── multi_edit_mini_app_file ───────────────────────────────────────────────

export const multiEditMiniAppFileTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Apply multiple text replacements to a single mini app file atomically. All edits succeed or none are applied. Edits are applied sequentially — each edit sees the result of previous ones.',
      inputSchema: z.object({
        app_id: z.string(),
        path: z.string().describe('Relative file path (e.g. "app.jsx")'),
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
      execute: async ({ app_id, path, edits }) => {
        log.debug({ agentId: ctx.agentId, appId: app_id, path }, 'multi_edit_mini_app_file invoked')

        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        try {
          const buffer = await readAppFile(app_id, path)
          let content = buffer.toString('utf-8')

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
                path,
              }
            }

            if (occurrences > 1) {
              return {
                success: false,
                error: `Edit #${i + 1}: oldText matches ${occurrences} locations. It must match exactly once. Use a larger context to disambiguate.`,
                failedEditIndex: i,
                editsAppliedBeforeFailure: i,
                path,
              }
            }

            content = content.replace(oldText, newText)
          }

          // All edits succeeded — write once
          await writeAppFile(app_id, path, content)

          const row = await getMiniAppRow(app_id)
          if (row) {
            sseManager.broadcast({
              type: 'miniapp:file-updated',
              agentId: ctx.agentId,
              data: { appId: app_id, path, version: row.version },
            })
          }

          log.info(
            { agentId: ctx.agentId, appId: app_id, path, editsApplied: edits.length },
            'Mini app file multi-edited',
          )

          return {
            success: true,
            path,
            editsApplied: edits.length,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to edit file'
          return { error: message }
        }
      },
    }),
}

// ─── get_mini_app_console ───────────────────────────────────────────────────

export const getMiniAppConsoleTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: (ctx) =>
    tool({
      description:
        'Get recent console output (logs, warnings, errors) from a running mini app. ' +
        'IMPORTANT: console output is only captured while the app is open in a browser tab — ' +
        'in a headless context the buffer stays empty. `lastServedAt` tells you when the app ' +
        'last (re)loaded; compare it to your last file write to know whether your changes have ' +
        'taken effect (use reload_mini_app to force a reload). `clear:true` empties the server buffer after reading.',
      inputSchema: z.object({
        app_id: z.string(),
        level: z.enum(['log', 'warn', 'error']).optional(),
        clear: z.boolean().optional().describe('Empty the buffer after reading'),
      }),
      execute: async ({ app_id, level, clear }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        const entries = getConsoleEntries(app_id, level)
        if (clear) clearConsoleEntries(app_id)

        const errorCount = entries.filter((e) => e.level === 'error').length
        const warnCount = entries.filter((e) => e.level === 'warn').length
        const servedAt = getServedAt(app_id)

        return {
          entries: entries.map((e) => ({
            level: e.level,
            message: e.args.join(' '),
            stack: e.stack,
            timestamp: new Date(e.timestamp).toISOString(),
          })),
          summary: {
            total: entries.length,
            errors: errorCount,
            warnings: warnCount,
            logs: entries.length - errorCount - warnCount,
          },
          lastServedAt: servedAt ? new Date(servedAt).toISOString() : null,
          note: entries.length === 0
            ? (servedAt
                ? 'No console entries. The app loaded but produced no console output yet, or the buffer was cleared.'
                : 'No console entries — the app is not open in any browser tab, so nothing is being captured. Ask the user to open it, or use reload_mini_app once it is open.')
            : undefined,
        }
      },
    }),
}

// ─── get_mini_app_backend_status ─────────────────────────────────────────────

export const getMiniAppBackendStatusTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Inspect the runtime state of a mini app backend (_server.js): whether an instance is ' +
        'loaded, background mode, scheduled jobs (ctx.schedule) with next run times, active managed ' +
        'timers, connected SSE subscribers, and the capability permission state (requested in ' +
        'app.json vs granted by the user).',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        const { getBackendStatus } = await import('@/server/services/mini-app-backend')
        const { getMiniAppPermissions } = await import('@/server/services/mini-apps')
        const status = getBackendStatus(app_id)
        const permissions = await getMiniAppPermissions(app_id)

        return {
          hasBackend: existing.hasBackend,
          loaded: status.loaded,
          background: status.background,
          loadedAt: status.loadedAt ? new Date(status.loadedAt).toISOString() : null,
          loadedVersion: status.version,
          currentVersion: existing.version,
          jobs: status.jobs.map((j) => ({
            name: j.name,
            pattern: j.pattern,
            nextRunAt: j.nextRunAt ? new Date(j.nextRunAt).toISOString() : null,
          })),
          activeTimers: status.activeTimers,
          sseSubscribers: status.sseSubscribers,
          eventSubscriptions: status.eventSubscriptions,
          permissions,
          note: !existing.hasBackend
            ? 'This app has no backend (_server.js).'
            : !status.loaded
              ? 'Backend not loaded — it loads on first request, or at boot/after edits when app.json has "background": true.'
              : undefined,
        }
      },
    }),
}

// ─── reload_mini_app ─────────────────────────────────────────────────────────

export const reloadMiniAppTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Force the mini app to reload in the browser (re-fetches the latest files). ' +
        'Only takes effect while the app is open in a browser tab — it cannot wake a headless app. ' +
        'Useful after writing files when auto-reload did not fire.',
      inputSchema: z.object({
        app_id: z.string(),
      }),
      execute: async ({ app_id }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }

        sseManager.broadcast({ type: 'miniapp:reload', agentId: ctx.agentId, data: { appId: app_id } })

        return {
          appId: app_id,
          message: 'Reload requested. The app will reload if it is currently open in a browser tab.',
          note: 'If nobody has the app open, this has no effect — check get_mini_app_console lastServedAt to confirm a reload happened.',
        }
      },
    }),
}

// ─── set_mini_app_maintainer ──────────────────────────────────────────────────

export const setMiniAppMaintainerTool: ToolRegistration = {
  availability: ['main'],
  create: (ctx) =>
    tool({
      description:
        'Reassign the maintainer Agent of a mini app (the Agent responsible for it and the target of "improve this app" requests). Any Agent can do this. `agent` accepts an Agent id or slug.',
      inputSchema: z.object({
        app_id: z.string(),
        agent: z.string().describe('Target maintainer Agent (id or slug)'),
      }),
      execute: async ({ app_id, agent }) => {
        const existing = await getMiniApp(app_id)
        if (!existing) return { error: 'App not found' }
        const targetAgentId = resolveAgentId(agent)
        if (!targetAgentId) return { error: `Agent "${agent}" not found` }
        try {
          const app = await setMiniAppMaintainer(app_id, targetAgentId)
          if (!app) return { error: 'App not found' }
          sseManager.broadcast({ type: 'miniapp:updated', agentId: ctx.agentId, data: { app } })
          return { appId: app_id, maintainerAgentId: app.maintainerAgentId, maintainerAgentName: app.maintainerAgentName, message: `Maintainer set to ${app.maintainerAgentName}` }
        } catch (err) {
          return { error: err instanceof Error ? err.message : 'Failed to set maintainer' }
        }
      },
    }),
}

