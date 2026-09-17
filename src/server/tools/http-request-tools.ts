import { tool } from '@/server/tools/tool-helper'
import { redactKnownSecrets } from '@/server/services/secret-substitution'
import { z } from 'zod'
import { createLogger } from '@/server/logger'
import { normalizeIpLiteral, isLoopbackOrUnspecified, isLinkLocal } from '@/server/services/ip-guard'
import type { ToolExecutionContext, ToolRegistration } from '@/server/tools/types'

const log = createLogger('tools:http-request')

const MAX_RESPONSE_BODY = 100 * 1024 // 100KB
const DEFAULT_TIMEOUT = 30_000

type UrlSafety =
  | { allowed: true }
  | { allowed: false; reason: string }

/**
 * Check whether a URL is safe for http_request.
 *
 * The TOOLBOX is the sole tool-grant primitive: there is no per-Agent network
 * flag. When `http_request` is granted (by listing it in a toolbox), it may
 * reach private / local hosts — to block that, simply don't grant the tool.
 *
 * The only hard, non-negotiable blocks remaining are loopback / unspecified
 * addresses, the link-local cloud-metadata endpoint, non-HTTP(S) schemes, and
 * invalid URLs. These protect the host process itself and are never toggleable.
 */
async function checkUrlSafety(urlStr: string): Promise<UrlSafety> {
  let url: URL
  try {
    url = new URL(urlStr)
  } catch {
    return { allowed: false, reason: 'Invalid URL' }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: 'Only HTTP and HTTPS URLs are supported' }
  }

  const host = url.hostname.toLowerCase()
  if (host === 'localhost') {
    return { allowed: false, reason: 'Requests to loopback or unspecified addresses are not allowed' }
  }

  // IP literals in any form (dotted, decimal `2130706433`, hex, bracketed
  // v6, v4-mapped v6) are normalized before the range checks — string
  // comparison alone does not "protect the host process".
  const literal = normalizeIpLiteral(host)
  if (literal) {
    if (isLoopbackOrUnspecified(literal)) {
      return { allowed: false, reason: 'Requests to loopback or unspecified addresses are not allowed' }
    }
    if (isLinkLocal(literal)) {
      return { allowed: false, reason: 'Requests to link-local metadata endpoints are not allowed' }
    }
    return { allowed: true }
  }

  // DNS names: resolve and apply the same loopback/link-local blocks (private
  // LAN stays allowed by design — the toolbox grant is the gate). Fails
  // closed on resolver error/timeout: failing open would let a slow or
  // attacker-controlled resolver route the request to the loopback.
  try {
    const lookupPromise = Bun.dns.lookup(host, { family: 0 })
    const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000))
    const results = await Promise.race([lookupPromise, timeoutPromise])
    if (!results) {
      return { allowed: false, reason: `DNS lookup for "${host}" timed out` }
    }
    for (const record of results) {
      if (isLoopbackOrUnspecified(record.address) || isLinkLocal(record.address)) {
        return { allowed: false, reason: `Host "${host}" resolves to blocked address ${record.address}` }
      }
    }
  } catch {
    return { allowed: false, reason: `DNS lookup for "${host}" failed` }
  }

  return { allowed: true }
}

/**
 * http_request - Make HTTP requests to external APIs.
 * Available to main Agents and sub-Agents. Granting the tool (via a toolbox) is the
 * only gate — there is no per-Agent network flag; private/local hosts are
 * reachable when the tool is granted (loopback + cloud-metadata stay blocked).
 */
export const httpRequestTool: ToolRegistration = {
  availability: ['main', 'sub-agent'],
  expandsSecrets: true,
  create: (_ctx: ToolExecutionContext) => {
    return tool({
      description:
        'Make an HTTP request to a URL. May reach private/internal and local-network hosts; only loopback and cloud-metadata endpoints are blocked.',
      inputSchema: z.object({
        method: z
          .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
        url: z.string().url(),
        headers: z
          .object({})
          .catchall(z.string())
          .optional()
          .describe('HTTP headers as key-value pairs (e.g. {"Authorization": "Bearer token"})'),
        body: z
          .union([z.string(), z.record(z.string(), z.unknown())])
          .optional()
          .describe('Objects auto-serialized to JSON'),
        timeout_seconds: z
          .number()
          .optional()
          .default(30)
          .describe('Default: 30, max: 120'),
      }),
      execute: async ({ method, url, headers, body, timeout_seconds }) => {
        // SSRF guard — loopback / metadata / non-HTTP(S) are always blocked.
        const urlSafety = await checkUrlSafety(url)
        if (!urlSafety.allowed) {
          return { error: urlSafety.reason }
        }

        const timeout = Math.min((timeout_seconds ?? 30) * 1000, 120_000)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)

        try {
          const fetchHeaders: Record<string, string> = { ...headers }

          let fetchBody: string | undefined
          if (body !== undefined) {
            if (typeof body === 'object') {
              fetchBody = JSON.stringify(body)
              if (!fetchHeaders['Content-Type'] && !fetchHeaders['content-type']) {
                fetchHeaders['Content-Type'] = 'application/json'
              }
            } else {
              fetchBody = body
            }
          }

          // The URL may carry a substituted secret (query param) at this point
          // — scrub known values before it lands in the server logs.
          log.debug({ method, url: redactKnownSecrets(url) }, 'HTTP request')

          // Redirects re-pass the safety check per hop: an allowed public
          // URL can otherwise 302 into the loopback or a metadata endpoint.
          let currentUrl = url
          let response: Response
          for (let hop = 0; ; hop++) {
            response = await fetch(currentUrl, {
              method,
              headers: fetchHeaders,
              body: fetchBody,
              signal: controller.signal,
              redirect: 'manual',
            })
            if (response.status < 300 || response.status >= 400) break
            const location = response.headers.get('location')
            if (!location) break
            if (hop >= 5) {
              return { error: 'Too many redirects (more than 5)' }
            }
            const nextUrl = new URL(location, currentUrl).toString()
            const hopSafety = await checkUrlSafety(nextUrl)
            if (!hopSafety.allowed) {
              return { error: `Redirect target blocked: ${hopSafety.reason}` }
            }
            currentUrl = nextUrl
          }

          // Read response body with size limit
          const contentType = response.headers.get('content-type') ?? ''
          let responseBody: string

          const buffer = await response.arrayBuffer()
          const bytes = new Uint8Array(buffer)

          if (bytes.length > MAX_RESPONSE_BODY) {
            responseBody = new TextDecoder().decode(bytes.slice(0, MAX_RESPONSE_BODY))
            responseBody += `\n\n[...truncated, response was ${bytes.length} bytes]`
          } else {
            responseBody = new TextDecoder().decode(bytes)
          }

          // Try to parse JSON for cleaner output
          let parsedBody: unknown = responseBody
          if (contentType.includes('application/json')) {
            try {
              parsedBody = JSON.parse(responseBody)
            } catch {
              // Keep as string
            }
          }

          // Extract relevant response headers
          const responseHeaders: Record<string, string> = {}
          for (const key of ['content-type', 'content-length', 'x-ratelimit-remaining', 'x-ratelimit-limit', 'retry-after', 'location']) {
            const val = response.headers.get(key)
            if (val) responseHeaders[key] = val
          }

          return {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
            body: parsedBody,
          }
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') {
            return { error: `Request timed out after ${timeout / 1000}s` }
          }
          return { error: err instanceof Error ? err.message : 'Unknown error' }
        } finally {
          clearTimeout(timer)
        }
      },
    })
  },
}
