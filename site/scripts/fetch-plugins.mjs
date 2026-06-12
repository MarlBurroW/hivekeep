#!/usr/bin/env bun
/**
 * Refresh site/src/data/plugins.json from the npm registry: every package
 * tagged with the `hivekeep-plugin` keyword (same convention as the in-app
 * marketplace, see src/server/services/pluginRegistry.ts), enriched with its
 * plugin.json manifest (displayName, iconUrl -> unpkg logo) and last-month
 * download counts.
 *
 * Best-effort by design: on any failure that would yield an EMPTY list, the
 * committed plugins.json is left untouched so the site always builds with
 * real content. Run by the pages workflow before `astro build`, and locally
 * with `bun site/scripts/fetch-plugins.mjs` to refresh the fallback.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const KEYWORD = 'hivekeep-plugin'
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'data', 'plugins.json')

async function getJson(url, fallback, timeoutMs = 8000) {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'hivekeep-site-plugins' },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return fallback
    return await res.json()
  } catch {
    return fallback
  }
}

/** npm `repository` URLs come in git+https/git@ forms browsers can't open. */
function normalizeRepo(url) {
  if (!url) return undefined
  let r = String(url)
  r = r.replace(/^git\+/, '')
  const ssh = r.match(/^git@([^:]+):(.+?)(\.git)?$/)
  if (ssh) r = `https://${ssh[1]}/${ssh[2]}`
  r = r.replace(/^git:\/\//, 'https://').replace(/\.git$/, '')
  return /^https?:\/\//.test(r) ? r : undefined
}

const search = await getJson(
  `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(`keywords:${KEYWORD}`)}&size=100`,
  null,
)

const objects = search?.objects ?? []
const plugins = (
  await Promise.all(
    objects.map(async (o) => {
      const p = o.package
      if (!p?.name || !p.version) return null

      // Manifest enrichment (displayName + logo), same convention as the app.
      const manifest = await getJson(`https://unpkg.com/${p.name}@${p.version}/plugin.json`, {}, 5000)
      const iconUrl =
        typeof manifest.iconUrl === 'string' && !manifest.iconUrl.includes('..')
          ? `https://unpkg.com/${p.name}@${p.version}/${manifest.iconUrl.replace(/^\/+/, '')}`
          : undefined

      const downloads = await getJson(
        `https://api.npmjs.org/downloads/point/last-month/${encodeURIComponent(p.name)}`,
        {},
        5000,
      )

      return {
        name: p.name,
        displayName: typeof manifest.displayName === 'string' ? manifest.displayName : undefined,
        version: p.version,
        // npm descriptions are external content; normalize em-dashes for display
        // (site-wide no-em-dash rule) without touching the package itself.
        description: (p.description ?? '').replace(/\s+\u2014\s+/g, ': ').replace(/\u2014/g, '-'),
        author: p.author?.name ?? p.publisher?.username ?? '',
        keywords: (p.keywords ?? []).filter((k) => k !== KEYWORD && k !== 'hivekeep'),
        date: p.date ?? null,
        downloads: typeof downloads.downloads === 'number' ? downloads.downloads : null,
        links: {
          npm: p.links?.npm ?? `https://www.npmjs.com/package/${p.name}`,
          repository: normalizeRepo(p.links?.repository),
          homepage: p.links?.homepage,
        },
        logoUrl: iconUrl,
      }
    }),
  )
).filter(Boolean)

// Most-installed first; ties (and missing counts) fall back to recency.
plugins.sort(
  (a, b) => (b.downloads ?? 0) - (a.downloads ?? 0) || Date.parse(b.date ?? 0) - Date.parse(a.date ?? 0),
)

if (plugins.length === 0) {
  console.error('npm search returned no plugins; keeping the committed plugins.json')
  process.exit(0)
}

writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), plugins }, null, 2) + '\n')
console.error(`Wrote ${OUT} (${plugins.length} plugins)`)
