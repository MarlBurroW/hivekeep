/**
 * Tests for remark-workspace-paths (files.md § 5.2). Mirrors the
 * Test harness: parse markdown, run the plugin,
 * inspect the synthetic `workspace-path` nodes. False positives are cheap
 * (they degrade to text after server verification) — false NEGATIVES on
 * realistic paths (spaces/accents in backticks) are the real regression risk.
 */
import { describe, it, expect } from 'bun:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { remarkWorkspacePaths } from './remark-workspace-paths'
import type { Root, RootContent } from 'mdast'

function parse(input: string): Root {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkWorkspacePaths)
    .runSync(unified().use(remarkParse).use(remarkGfm).parse(input)) as Root
}

function collectPaths(tree: Root): Array<{ path: string; wasCode: boolean }> {
  const out: Array<{ path: string; wasCode: boolean }> = []
  function walk(n: { type: string; children?: unknown[]; data?: { hName?: string; hProperties?: Record<string, unknown> } }) {
    if (n.data?.hName === 'workspace-path') {
      out.push({
        path: String(n.data.hProperties?.['data-path'] ?? ''),
        wasCode: n.data.hProperties !== undefined && 'data-was-code' in n.data.hProperties,
      })
    }
    if (Array.isArray(n.children)) for (const c of n.children) walk(c as never)
  }
  walk(tree as never)
  return out
}

describe('remarkWorkspacePaths — text nodes', () => {
  it('detects slashed paths and bare filenames with extensions', () => {
    const found = collectPaths(parse('See reports/analysis.md and also notes.txt for details'))
    expect(found.map((f) => f.path)).toEqual(['reports/analysis.md', 'notes.txt'])
  })

  it('detects several paths in one sentence (global flag)', () => {
    const found = collectPaths(parse('Compare a/b.ts with c/d.ts please'))
    expect(found.map((f) => f.path)).toEqual(['a/b.ts', 'c/d.ts'])
  })

  it('ignores URLs (gfm autolinks) and version numbers', () => {
    const found = collectPaths(parse('Go to https://example.com/docs/guide.md — version 1.2.3 shipped'))
    expect(found).toEqual([])
  })

  it('handles punctuation boundaries', () => {
    const found = collectPaths(parse('Open docs/guide.md, then (src/main.ts) and "lib/x.js".'))
    expect(found.map((f) => f.path)).toEqual(['docs/guide.md', 'src/main.ts', 'lib/x.js'])
  })

  it('does not fire on plain prose', () => {
    expect(collectPaths(parse('Bonjour, voici le rapport demandé hier soir.'))).toEqual([])
  })
})

describe('remarkWorkspacePaths — inline code', () => {
  it('converts a backticked path (the @ palette / agent convention)', () => {
    const found = collectPaths(parse('Voici `reports/analysis.md` comme demandé'))
    expect(found).toEqual([{ path: 'reports/analysis.md', wasCode: true }])
  })

  it('is permissive with spaces and accents inside backticks', () => {
    const found = collectPaths(parse('Fichier : `rapports/Rapport final 2026.md` et `synthèse.md`'))
    expect(found.map((f) => f.path)).toEqual(['rapports/Rapport final 2026.md', 'synthèse.md'])
  })

  it('leaves non-path inline code alone', () => {
    const found = collectPaths(parse('Run `npm install` then `const x = 1`'))
    expect(found).toEqual([])
  })

  it('does NOT touch fenced code blocks', () => {
    const found = collectPaths(parse('```\nreports/analysis.md\n```'))
    expect(found).toEqual([])
  })
})
