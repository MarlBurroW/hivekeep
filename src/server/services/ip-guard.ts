import { isIP } from 'node:net'

/**
 * IP-literal normalization and range checks shared by the SSRF guards
 * (web-browse, http_request). Guards that compare `url.hostname` against
 * literal strings are trivially bypassed: `http://2130706433/`,
 * `http://0x7f000001/`, `http://127.1/` and `http://[::ffff:127.0.0.1]/` all
 * reach 127.0.0.1 without ever matching the string '127.0.0.1'.
 */

/** Parse one IPv4 dotted-form part (decimal, 0x hex, or 0-prefixed octal). */
function parseV4Part(part: string): number | null {
  if (!part) return null
  let value: number
  if (/^0x[0-9a-f]+$/i.test(part)) value = parseInt(part, 16)
  else if (/^0[0-7]*$/.test(part)) value = parseInt(part, 8)
  else if (/^[0-9]+$/.test(part)) value = parseInt(part, 10)
  else return null
  return Number.isFinite(value) ? value : null
}

/**
 * Normalize any IP-literal hostname to a canonical address, or null when the
 * hostname is a DNS name. Handles bracketed IPv6, standard IPv4/IPv6, and the
 * inet_aton shorthand forms (decimal `2130706433`, hex `0x7f000001`, octal,
 * and partial dotted forms like `127.1`).
 */
export function normalizeIpLiteral(hostname: string): string | null {
  let host = hostname.toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (isIP(host) === 6) return host
  if (isIP(host) === 4) return host

  // inet_aton shorthand: 1, 2, 3 or 4 parts, last part fills remaining bytes.
  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const values = parts.map(parseV4Part)
  if (values.some((v) => v === null)) return null
  const nums = values as number[]
  const last = nums[nums.length - 1]!
  const heads = nums.slice(0, -1)
  if (heads.some((v) => v > 255)) return null
  const remainingBytes = 4 - heads.length
  if (last >= 2 ** (8 * remainingBytes)) return null
  let ip = 0
  for (const h of heads) ip = ip * 256 + h
  ip = ip * 2 ** (8 * remainingBytes) + last
  return [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.')
}

/** Strip an IPv4-mapped IPv6 prefix so v4 range checks apply. Handles both
 *  the dotted form (::ffff:127.0.0.1) and the hex-group form the URL parser
 *  normalizes to (::ffff:7f00:1). */
function unmapV6(ip: string): string {
  const lower = ip.toLowerCase()
  if (!lower.startsWith('::ffff:')) return lower
  const rest = lower.slice(7)
  if (isIP(rest) === 4) return rest
  const m = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest)
  if (m) {
    const hi = parseInt(m[1]!, 16)
    const lo = parseInt(m[2]!, 16)
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
  }
  return lower
}

export function isLoopbackOrUnspecified(ip: string): boolean {
  const v = unmapV6(ip)
  if (v === '::1' || v === '::' || v === '0:0:0:0:0:0:0:1') return true
  return /^127\./.test(v) || /^0\./.test(v) || v === '0.0.0.0'
}

export function isLinkLocal(ip: string): boolean {
  const v = unmapV6(ip)
  if (/^169\.254\./.test(v)) return true
  // fe80::/10
  return /^fe[89ab]/i.test(v)
}

export function isPrivateIp(ip: string): boolean {
  const v = unmapV6(ip)
  if (isLoopbackOrUnspecified(v) || isLinkLocal(v)) return true
  if (/^10\./.test(v)) return true
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v)) return true
  if (/^192\.168\./.test(v)) return true
  // IPv6 unique-local fc00::/7
  return /^f[cd]/i.test(v)
}
