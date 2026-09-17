import { tool } from '@/server/tools/tool-helper'
import { z } from 'zod'
import {
  browseUrl,
  extractLinks,
  extractContent,
  isBlockedUrl,
} from '@/server/services/web-browse'
import { playwrightManager } from '@/server/services/playwright-manager'
import { storeBrowserScreenshot } from '@/server/services/browser-screenshots'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import type { ToolRegistration } from '@/server/tools/types'
import type { ExtractMode } from '@/server/services/web-browse'

const log = createLogger('tools:browse')

// ─── browse_url ─────────────────────────────────────────────────────────────

export const browseUrlTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  expandsSecrets: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Fetch a web page and extract readable content. Use after web_search to read full page content.',
      inputSchema: z.object({
        url: z.string().url(),
        extract_mode: z
          .enum(['readability', 'markdown', 'raw'])
          .optional()
          .describe('Default: readability'),
        wait_for_js: z
          .boolean()
          .optional()
          .describe('Render JS via headless browser. Default: false'),
      }),
      execute: async ({ url, extract_mode, wait_for_js }) => {
        const mode: ExtractMode = extract_mode ?? 'readability'
        log.debug({ url, mode, wait_for_js }, 'browse_url invoked')

        try {
          if (wait_for_js) {
            // Headless browser path — render JS then extract with same extractors
            const blocked = await isBlockedUrl(url)
            if (blocked.blocked) {
              return { error: `URL blocked: ${blocked.reason}` }
            }

            const start = Date.now()
            const browserResult = await playwrightManager.browseWithBrowser(url, mode)
            const extracted = extractContent(browserResult.html, browserResult.url, mode)

            const content = extracted.content.slice(0, config.webBrowsing.maxContentLength)
            return {
              url: browserResult.url,
              title: extracted.title ?? browserResult.title,
              content,
              contentLength: content.length,
              extractMode: mode,
              fetchTimeMs: Date.now() - start,
              renderedWithBrowser: true,
            }
          }

          // Lightweight fetch path (default)
          return await browseUrl(url, mode)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn({ url, error: message }, 'browse_url failed')
          return { error: message }
        }
      },
    }),
}

// ─── extract_links ──────────────────────────────────────────────────────────

export const extractLinksTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  readOnly: true,
  concurrencySafe: true,
  create: () =>
    tool({
      description:
        'Extract all links from a web page. Use to discover sub-pages or resources on a site.',
      inputSchema: z.object({
        url: z.string().url(),
        filter_pattern: z
          .string()
          .optional()
          .describe('Regex to filter link URLs (e.g. "\\.pdf$")'),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Default: 50'),
      }),
      execute: async ({ url, filter_pattern, max_results }) => {
        log.debug({ url, filter_pattern }, 'extract_links invoked')

        try {
          return await extractLinks(url, filter_pattern, max_results ?? 50)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn({ url, error: message }, 'extract_links failed')
          return { error: message }
        }
      },
    }),
}

// ─── screenshot_url ─────────────────────────────────────────────────────────

export const screenshotUrlTool: ToolRegistration = {
  availability: ['main'],
  readOnly: true,
  expandsSecrets: true,
  create: (ctx) =>
    tool({
      description:
        'Take a screenshot of a web page. Requires headless browser.',
      inputSchema: z.object({
        url: z.string().url(),
        viewport_width: z
          .number()
          .int()
          .min(320)
          .max(1920)
          .optional()
          .describe('Pixels. Default: 1280'),
        viewport_height: z
          .number()
          .int()
          .min(240)
          .max(1080)
          .optional()
          .describe('Pixels. Default: 720'),
        full_page: z
          .boolean()
          .optional()
          .describe('Capture full scrollable page. Default: false'),
      }),
      execute: async ({ url, viewport_width, viewport_height, full_page }) => {
        log.debug({ url, agentId: ctx.agentId, sessionId: ctx.sessionId }, 'screenshot_url invoked')

        try {
          const blocked = await isBlockedUrl(url)
          if (blocked.blocked) {
            return { error: `URL blocked: ${blocked.reason}` }
          }

          const result = await playwrightManager.screenshotPage(url, {
            width: viewport_width,
            height: viewport_height,
            fullPage: full_page,
          })

          // Store the screenshot as a file
          const hostname = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '_')
          const name = `screenshot-${hostname}-${Date.now()}`
          const file = await storeBrowserScreenshot(ctx, name, result.buffer, url)

          return {
            url,
            fileId: file.id,
            fileUrl: file.url,
            width: result.width,
            height: result.height,
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn({ url, error: message, sessionId: ctx.sessionId }, 'screenshot_url failed')
          return { error: message }
        }
      },
    }),
}
