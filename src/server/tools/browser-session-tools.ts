import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import { eq } from 'drizzle-orm'
import { db } from '@/server/db/index'
import { tasks } from '@/server/db/schema'
import { playwrightManager, parseCookieInput, type CookieSpec } from '@/server/services/playwright-manager'
import { getPageState, locatorForRef } from '@/server/services/browser-snapshot'
import { isBlockedUrl } from '@/server/services/web-browse'
import { createFileFromContent } from '@/server/services/file-storage'
import { storeBrowserScreenshot } from '@/server/services/browser-screenshots'
import { createHumanPrompt } from '@/server/services/human-prompts'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import type { ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:browser')

// ─── Helpers ────────────────────────────────────────────────────────────────

function err(message: string) {
  return { error: message }
}

async function snapshotAfterAction(sessionId: string, agentId: string) {
  const session = playwrightManager.resolveSession(sessionId, agentId)
  const state = await getPageState(session.page)
  await playwrightManager.refreshSessionMeta(session)
  return state
}

// ─── Session lifecycle ──────────────────────────────────────────────────────

export const browserOpenSessionTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Open a stateful browser session (page state, cookies, login persist across calls). Returns a session_id required by all other browser_* calls. Optionally pre-load a saved state and navigate to a start URL. Max one active session per Agent.',
      inputSchema: z.object({
        start_url: z.string().url().optional().describe('If provided, navigate to this URL after opening.'),
        load_state: z
          .string()
          .optional()
          .describe('Name of a previously saved state to pre-load (cookies + localStorage). Use browser_list_states to see available names. Cookies/localStorage from the saved state are applied before any cookies parameter (cookies override).'),
        cookies: z
          .union([z.string(), z.array(z.record(z.string(), z.unknown()))])
          .optional()
          .describe(
            'Cookies to inject before navigation. Either a JSON array of cookie objects ({name, value, domain?, path?, expires?, httpOnly?, secure?, sameSite?}) — preferred — or a Cookie header string ("name1=val1; name2=val2"). When passing a header string OR cookies without explicit domain, you MUST provide default_cookie_domain.',
          ),
        default_cookie_domain: z
          .string()
          .optional()
          .describe('Domain applied to cookies that have no explicit domain (e.g., ".github.com"). Required for header-string format.'),
        viewport_width: z.number().int().min(320).max(1920).optional(),
        viewport_height: z.number().int().min(240).max(1080).optional(),
        user_agent: z.string().optional().describe('Override the User-Agent for this session.'),
      }),
      execute: async (args) => {
        log.debug({ agentId: ctx.agentId, taskId: ctx.taskId, startUrl: args.start_url, loadState: args.load_state }, 'browser_open_session')
        try {
          if (args.start_url) {
            const blocked = await isBlockedUrl(args.start_url)
            if (blocked.blocked) return err(`URL blocked: ${blocked.reason}`)
          }

          let cookies: CookieSpec[] | undefined
          if (args.cookies !== undefined) {
            cookies = parseCookieInput(args.cookies, args.default_cookie_domain)
          }

          let storageState: import('@/server/services/playwright-manager').BrowserStorageState | undefined
          let loadedFrom: { name: string; savedAt: number; savedFromUrl: string | null } | undefined
          if (args.load_state) {
            const file = await playwrightManager.loadSavedState(ctx.agentId, args.load_state)
            storageState = file.storageState
            loadedFrom = { name: file.name, savedAt: file.savedAt, savedFromUrl: file.savedFromUrl }
          }

          const viewport =
            args.viewport_width || args.viewport_height
              ? {
                  width: args.viewport_width ?? config.browserSessions.defaultViewport.width,
                  height: args.viewport_height ?? config.browserSessions.defaultViewport.height,
                }
              : undefined

          const session = await playwrightManager.openSession({
            agentId: ctx.agentId,
            taskId: ctx.taskId,
            startUrl: args.start_url,
            cookies,
            storageState,
            viewport,
            userAgent: args.user_agent,
          })

          let pageState = null
          if (args.start_url) {
            pageState = await snapshotAfterAction(session.sessionId, ctx.agentId)
          }

          return {
            session_id: session.sessionId,
            url: session.url,
            title: session.title,
            cookies_injected: cookies?.length ?? 0,
            state_loaded: loadedFrom ?? null,
            page_state: pageState,
          }
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          log.warn({ agentId: ctx.agentId, error: message }, 'browser_open_session failed')
          return err(message)
        }
      },
    }),
}

export const browserCloseSessionTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Close a stateful browser session and free its resources. Always call this when you no longer need the session.',
      inputSchema: z.object({
        session_id: z.string(),
      }),
      execute: async ({ session_id }) => {
        try {
          // Verify ownership before closing
          playwrightManager.resolveSession(session_id, ctx.agentId)
          await playwrightManager.closeSession(session_id, { reason: 'tool' })
          return { closed: true }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserListSessionsTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  readOnly: true,
  create: (ctx) =>
    tool({
      description: 'List active browser sessions owned by this Agent. Useful to recover a session_id you forgot.',
      inputSchema: z.object({}),
      execute: async () => {
        const sessions = playwrightManager.listSessions(ctx.agentId)
        return { sessions }
      },
    }),
}

// ─── Navigation & actions ───────────────────────────────────────────────────

export const browserNavigateTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Navigate the session\'s page to a URL. Returns the new page_state.',
      inputSchema: z.object({
        session_id: z.string(),
        url: z.string().url(),
        wait_until: z
          .enum(['load', 'domcontentloaded', 'networkidle', 'commit'])
          .optional()
          .describe('Default: domcontentloaded'),
      }),
      execute: async ({ session_id, url, wait_until }) => {
        try {
          const blocked = await isBlockedUrl(url)
          if (blocked.blocked) return err(`URL blocked: ${blocked.reason}`)

          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          await session.page.goto(url, {
            waitUntil: wait_until ?? 'domcontentloaded',
            timeout: config.webBrowsing.pageTimeout,
          })
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserClickTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Click an element by its `ref` from the LATEST page_state. Older refs are stale.',
      inputSchema: z.object({
        session_id: z.string(),
        ref: z.string(),
      }),
      execute: async ({ session_id, ref }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          const locator = locatorForRef(session.page, ref)
          await locator.click({ timeout: 10_000 })
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserTypeTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Type text into an input/textarea/contenteditable identified by `ref`. Set submit=true to press Enter after typing (useful for search forms).',
      inputSchema: z.object({
        session_id: z.string(),
        ref: z.string(),
        text: z.string(),
        submit: z.boolean().optional().describe('Press Enter after typing. Default: false'),
        clear_first: z.boolean().optional().describe('Clear the field before typing. Default: true'),
      }),
      execute: async ({ session_id, ref, text, submit, clear_first }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          const locator = locatorForRef(session.page, ref)
          if (clear_first !== false) await locator.fill(text)
          else await locator.type(text)
          if (submit) await locator.press('Enter')
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserSelectTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Select an option in a native <select> identified by `ref`. Pass the option value (or label).',
      inputSchema: z.object({
        session_id: z.string(),
        ref: z.string(),
        value: z.string(),
      }),
      execute: async ({ session_id, ref, value }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          const locator = locatorForRef(session.page, ref)
          // Try by value first, fall back to label
          try {
            await locator.selectOption({ value })
          } catch {
            await locator.selectOption({ label: value })
          }
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserPressKeyTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Press a keyboard key (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a"). Sent to `ref` element if provided, else to the page.',
      inputSchema: z.object({
        session_id: z.string(),
        key: z.string(),
        ref: z.string().optional(),
      }),
      execute: async ({ session_id, key, ref }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          if (ref) {
            await locatorForRef(session.page, ref).press(key)
          } else {
            await session.page.keyboard.press(key)
          }
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserScrollTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Scroll the page. Direction "down"/"up" scrolls by one viewport height by default; "top"/"bottom" jumps to the extremes.',
      inputSchema: z.object({
        session_id: z.string(),
        direction: z.enum(['up', 'down', 'top', 'bottom']),
        amount_px: z.number().int().min(1).optional().describe('Pixels to scroll for up/down. Default: viewport height.'),
      }),
      execute: async ({ session_id, direction, amount_px }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          await session.page.evaluate(
            ({ direction, amount_px }) => {
              const h = amount_px ?? window.innerHeight
              if (direction === 'down') window.scrollBy({ top: h, behavior: 'instant' as ScrollBehavior })
              else if (direction === 'up') window.scrollBy({ top: -h, behavior: 'instant' as ScrollBehavior })
              else if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' as ScrollBehavior })
              else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' as ScrollBehavior })
            },
            { direction, amount_px },
          )
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserWaitForTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Wait for a condition: url=<pattern>, ref=<refId>, text=<substring>, or ms=<milliseconds>. Use after async-triggering actions.',
      inputSchema: z.object({
        session_id: z.string(),
        condition: z.string().describe('e.g. "url=https://example.com/dashboard", "ref=e5", "text=Welcome back", "ms=2000"'),
        timeout_ms: z.number().int().min(100).max(60_000).optional().describe('Default: 15000'),
      }),
      execute: async ({ session_id, condition, timeout_ms }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          const timeout = timeout_ms ?? 15_000
          const eq = condition.indexOf('=')
          if (eq < 0) return err(`Invalid condition "${condition}". Use kind=value (e.g. "url=...", "ref=...", "text=...", "ms=...").`)
          const kind = condition.slice(0, eq).trim()
          const value = condition.slice(eq + 1).trim()
          switch (kind) {
            case 'url':
              await session.page.waitForURL(value, { timeout })
              break
            case 'ref':
              await locatorForRef(session.page, value).waitFor({ state: 'visible', timeout })
              break
            case 'text':
              await session.page.getByText(value, { exact: false }).first().waitFor({ state: 'visible', timeout })
              break
            case 'ms': {
              const ms = Number(value)
              if (!Number.isFinite(ms)) return err(`ms condition value "${value}" is not a number`)
              await session.page.waitForTimeout(Math.min(ms, timeout))
              break
            }
            default:
              return err(`Unknown condition kind "${kind}". Use url, ref, text, or ms.`)
          }
          return { page_state: await snapshotAfterAction(session_id, ctx.agentId) }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

// ─── Screenshots ────────────────────────────────────────────────────────────

export const browserScreenshotTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  readOnly: true,
  create: (ctx) =>
    tool({
      description: 'Take a screenshot of the session\'s current page and save it as a shareable file. Returns a fileUrl. Use full_page=true to capture beyond the viewport.',
      inputSchema: z.object({
        session_id: z.string(),
        full_page: z.boolean().optional(),
      }),
      execute: async ({ session_id, full_page }) => {
        try {
          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          const buffer = await session.page.screenshot({ type: 'png', fullPage: full_page ?? false })
          const hostname = new URL(session.page.url()).hostname.replace(/[^a-z0-9.-]/gi, '_')
          const name = `session-screenshot-${hostname}-${Date.now()}`
          const file = await storeBrowserScreenshot(ctx, name, buffer, session.page.url())
          await playwrightManager.refreshSessionMeta(session)
          return {
            url: session.page.url(),
            fileId: file.id,
            fileUrl: file.url,
            full_page: full_page ?? false,
          }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

// ─── Cookies ────────────────────────────────────────────────────────────────

export const browserSetCookiesTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Inject cookies (skip a login flow). Accepts JSON array of cookie objects OR a Cookie header string ("a=1; b=2"); set default_cookie_domain when domain is missing. Persists for the session lifetime.',
      inputSchema: z.object({
        session_id: z.string(),
        cookies: z.union([z.string(), z.array(z.record(z.string(), z.unknown()))]),
        default_cookie_domain: z.string().optional(),
      }),
      execute: async ({ session_id, cookies, default_cookie_domain }) => {
        try {
          const parsed = parseCookieInput(cookies, default_cookie_domain)
          const added = await playwrightManager.setCookies(session_id, ctx.agentId, parsed)
          return { added }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserGetCookiesTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  readOnly: true,
  create: (ctx) =>
    tool({
      description: 'Read cookies currently set in the session. Optionally filter by URL(s). Useful to inspect auth state or export cookies (e.g. to save in the Vault for next time).',
      inputSchema: z.object({
        session_id: z.string(),
        urls: z.array(z.string().url()).optional(),
      }),
      execute: async ({ session_id, urls }) => {
        try {
          const cookies = await playwrightManager.getCookies(session_id, ctx.agentId, urls)
          return { cookies }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserClearCookiesTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Clear all cookies from the session.',
      inputSchema: z.object({
        session_id: z.string(),
      }),
      execute: async ({ session_id }) => {
        try {
          await playwrightManager.clearCookies(session_id, ctx.agentId)
          return { cleared: true }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

// ─── State persistence (save / load across sessions) ───────────────────────

export const browserSaveStateTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description:
        'Save the current session state (cookies + localStorage + sessionStorage) under a name so you can resume later via browser_open_session({ load_state: name }). Use after login to skip subsequent auth.',
      inputSchema: z.object({
        session_id: z.string(),
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i)
          .describe('Identifier for this saved state. 1-64 chars, alphanumeric + dash + underscore (e.g. "github-personal", "my-bank"). Re-using an existing name OVERWRITES it.'),
        description: z
          .string()
          .max(280)
          .optional()
          .describe('Optional human-readable note (e.g. "Logged in as MarlBurroW on github.com").'),
      }),
      execute: async ({ session_id, name, description }) => {
        try {
          const meta = await playwrightManager.saveSessionState(session_id, ctx.agentId, name, description)
          return { saved: true, ...meta }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserListStatesTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  readOnly: true,
  create: (ctx) =>
    tool({
      description: 'List saved browser states for this Agent (name, saved-at, source URL, description, size). Load one via browser_open_session({ load_state: name }).',
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const states = await playwrightManager.listSavedStates(ctx.agentId)
          return { states, count: states.length }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

export const browserDeleteStateTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) =>
    tool({
      description: 'Delete a saved browser state by name. Irreversible — back up under another name first if unsure.',
      inputSchema: z.object({
        name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i),
      }),
      execute: async ({ name }) => {
        try {
          const deleted = await playwrightManager.deleteSavedState(ctx.agentId, name)
          return { deleted, name }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    }),
}

// ─── Human-in-the-loop ──────────────────────────────────────────────────────

export const browserRequestHumanTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  defaultDisabled: true,
  create: (ctx) => {
    let calledThisTurn = false
    return tool({
      description:
        'Ask the user to intervene on the browser session (captcha, 2FA, unexpected modal). Captures a screenshot, pauses your task until Continue/Cancel. After Continue, retry the action or call browser_screenshot to see the new state.',
      inputSchema: z.object({
        session_id: z.string(),
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe('Short, human-readable explanation of why you need help (will be shown to the user as the question).'),
        continue_label: z
          .string()
          .max(40)
          .optional()
          .describe('Optional label for the Continue button. Default: "Continue". Match the user\'s language.'),
        cancel_label: z
          .string()
          .max(40)
          .optional()
          .describe('Optional label for the Cancel button. Default: "Cancel". Match the user\'s language.'),
        full_page: z
          .boolean()
          .optional()
          .describe('Capture the full scrollable page instead of just the viewport. Default: false.'),
      }),
      execute: async ({ session_id, reason, continue_label, cancel_label, full_page }) => {
        // Intervention cards, screenshots and notifications are shared.
        if (ctx.sessionId) {
          return err('browser_request_human is not available in private sessions. Ask the user in the private conversation text instead.')
        }
        try {
          if (calledThisTurn) {
            return err('You already requested human intervention this turn. Wait for the user response before asking again.')
          }
          calledThisTurn = true

          // Guard: cron-spawned sub-Agent tasks cannot prompt humans
          if (ctx.taskId) {
            const task = await db.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get()
            if (!task) return err('Task not found')
            if (task.cronId) return err('browser_request_human is not available in cron-triggered tasks')
            if (!task.allowHumanPrompt) return err('Human prompts are disabled for this task by the parent')
          }

          const session = playwrightManager.resolveSession(session_id, ctx.agentId)
          const buffer = await session.page.screenshot({ type: 'png', fullPage: full_page ?? false })
          const hostname = new URL(session.page.url()).hostname.replace(/[^a-z0-9.-]/gi, '_')
          const name = `intervention-${hostname}-${Date.now()}`
          const file = await createFileFromContent(ctx.agentId, name, buffer.toString('base64'), 'image/png', {
            isBase64: true,
            description: `Browser intervention screenshot at ${session.page.url()}`,
            isPublic: true,
            createdByAgentId: ctx.agentId,
          })
          await playwrightManager.refreshSessionMeta(session)

          // Description embeds the screenshot as markdown image so HumanPromptCard
          // (now markdown-rendered) displays it inline. Cap at description.max=1000 chars.
          const description =
            `![${name}](${file.url})\n\n` +
            `**URL** : ${session.page.url()}` +
            (session.title ? `\n**Page** : ${session.title}` : '')

          const { promptId } = await createHumanPrompt({
            agentId: ctx.agentId,
            taskId: ctx.taskId,
            promptType: 'confirm',
            question: reason,
            description: description.slice(0, 1000),
            options: [
              { label: continue_label ?? 'Continue', value: 'continue', variant: 'success' },
              { label: cancel_label ?? 'Cancel', value: 'cancel', variant: 'destructive' },
            ],
          })

          log.info({ agentId: ctx.agentId, taskId: ctx.taskId, sessionId: session_id, promptId }, 'browser_request_human prompt created')

          return {
            promptId,
            status: 'pending',
            session_id,
            screenshot_url: file.url,
            message: 'The user has been shown the screenshot and asked to either Continue or Cancel. Wait for their response — it will arrive as a new message. After Continue, take a fresh screenshot or page_state to see the new state.',
          }
        } catch (e) {
          return err(e instanceof Error ? e.message : String(e))
        }
      },
    })
  },
}
