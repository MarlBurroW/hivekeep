// ─── Lightweight semver range checking ───────────────────────────────────────
//
// Supports: >=X.Y.Z, <=X.Y.Z, >X.Y.Z, <X.Y.Z, =X.Y.Z, X.Y.Z (exact),
//           ^X.Y.Z (compatible), ~X.Y.Z (patch-level), and space-separated AND.
//
// Examples:
//   ">=0.15.0"         → 0.15.0+
//   ">=0.15.0 <1.0.0"  → 0.15.0 to 0.99.99
//   "^0.16.0"          → >=0.16.0 <0.17.0 (caret with 0.x)
//   "~0.16.2"          → >=0.16.2 <0.17.0

function parseSemver(v: string): [number, number, number] {
  const parts = v.replace(/^v/, '').split('.').map(Number)
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function compareSemver(a: [number, number, number], b: [number, number, number]): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1
    if (a[i]! > b[i]!) return 1
  }
  return 0
}

interface Constraint {
  op: '>=' | '<=' | '>' | '<' | '='
  version: [number, number, number]
}

function parseConstraint(token: string): Constraint[] {
  token = token.trim()

  // Caret: ^X.Y.Z
  if (token.startsWith('^')) {
    const ver = parseSemver(token.slice(1))
    const [major, minor] = ver
    // ^0.Y.Z → >=0.Y.Z <0.(Y+1).0
    // ^X.Y.Z (X>0) → >=X.Y.Z <(X+1).0.0
    const upper: [number, number, number] = major === 0
      ? [0, minor + 1, 0]
      : [major + 1, 0, 0]
    return [
      { op: '>=', version: ver },
      { op: '<', version: upper },
    ]
  }

  // Tilde: ~X.Y.Z → >=X.Y.Z <X.(Y+1).0
  if (token.startsWith('~')) {
    const ver = parseSemver(token.slice(1))
    return [
      { op: '>=', version: ver },
      { op: '<', version: [ver[0], ver[1] + 1, 0] },
    ]
  }

  // Operator prefix
  const match = token.match(/^(>=|<=|>|<|=)?(.+)$/)
  if (!match) return []
  const op = (match[1] || '=') as Constraint['op']
  return [{ op, version: parseSemver(match[2]!) }]
}

function matchesConstraint(ver: [number, number, number], c: Constraint): boolean {
  const cmp = compareSemver(ver, c.version)
  switch (c.op) {
    case '>=': return cmp >= 0
    case '<=': return cmp <= 0
    case '>': return cmp > 0
    case '<': return cmp < 0
    case '=': return cmp === 0
  }
}

/**
 * Strictly newer? Used by the update checker to avoid flagging an
 * "update available" when the registry's `latest` is stale (CDN cache
 * lag after a fresh publish) and actually points at an older version
 * than what's already installed.
 */
export function isVersionNewer(candidate: string, baseline: string): boolean {
  return compareSemver(parseSemver(candidate), parseSemver(baseline)) > 0
}

/**
 * Check if a version satisfies a semver range expression.
 * Tokens separated by spaces are AND-ed.
 * Returns true if range is empty/undefined.
 */
export function satisfiesSemver(version: string, range: string | undefined): boolean {
  if (!range || !range.trim()) return true

  const ver = parseSemver(version)
  const tokens = range.trim().split(/\s+/)
  const constraints = tokens.flatMap(parseConstraint)

  return constraints.every(c => matchesConstraint(ver, c))
}
