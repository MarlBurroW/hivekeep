import { describe, it, expect } from 'bun:test'
import {
  parseMaintenanceResponse,
  enforcePinned,
  enforceBudget,
  buildMaintenancePrompt,
  BOUNDARY_TEST,
  selectArchiveIndex,
} from '@/server/services/memory-maintenance'
import { countTokens } from '@/shared/token-estimator'

const ITEM = '{"action":"add","content":"Nicolas prefers concise answers","category":"preference","subject":"Nicolas","importance":7}'

describe('parseMaintenanceResponse', () => {
  it('parses both blocks from a well-formed response', () => {
    const res = parseMaintenanceResponse(
      `<archive>\n[${ITEM}]\n</archive>\n\n<profile>\n## Active projects\n\n- Memory v2.\n</profile>`,
    )
    expect(res.archive).toHaveLength(1)
    expect(res.archive[0]!.content).toBe('Nicolas prefers concise answers')
    expect(res.archive[0]!.action).toBe('add')
    expect(res.profile).toBe('## Active projects\n\n- Memory v2.')
  })

  it('keeps the profile null when the block is absent, so the caller keeps the old one', () => {
    const res = parseMaintenanceResponse(`<archive>\n[${ITEM}]\n</archive>`)
    expect(res.archive).toHaveLength(1)
    expect(res.profile).toBeNull()
  })

  it('treats an empty profile block as absent', () => {
    const res = parseMaintenanceResponse('<archive>\n[]\n</archive>\n<profile>\n\n</profile>')
    expect(res.profile).toBeNull()
  })

  it('still applies archive items when the profile block is malformed', () => {
    const res = parseMaintenanceResponse(`<archive>\n[${ITEM}]\n</archive>\n<profile>`)
    expect(res.archive).toHaveLength(1)
    expect(res.profile).toBeNull()
  })

  it('still rewrites the profile when the archive JSON is broken', () => {
    const res = parseMaintenanceResponse(
      '<archive>\n[{broken json\n</archive>\n<profile>\n## Pinned\n\n- Keep me.\n</profile>',
    )
    expect(res.archive).toEqual([])
    expect(res.profile).toBe('## Pinned\n\n- Keep me.')
  })

  it('falls back to a bare JSON array when the model drops the archive tags', () => {
    const res = parseMaintenanceResponse(
      `Here is what I found:\n[${ITEM}]\n<profile>\n## Pinned\n\n- Keep me.\n</profile>`,
    )
    expect(res.archive).toHaveLength(1)
    expect(res.profile).toBe('## Pinned\n\n- Keep me.')
  })

  it('strips a code fence around the profile', () => {
    const res = parseMaintenanceResponse(
      '<archive>[]</archive>\n<profile>\n```markdown\n## Pinned\n\n- Keep me.\n```\n</profile>',
    )
    expect(res.profile).toBe('## Pinned\n\n- Keep me.')
  })

  it('drops archive entries missing content or category', () => {
    const res = parseMaintenanceResponse(
      '<archive>[{"content":"no category"},{"category":"fact"},' + ITEM + ']</archive>',
    )
    expect(res.archive).toHaveLength(1)
    expect(res.archive[0]!.content).toBe('Nicolas prefers concise answers')
  })

  it('returns nothing usable for a response with neither block', () => {
    const res = parseMaintenanceResponse('I could not find anything worth remembering.')
    expect(res.archive).toEqual([])
    expect(res.profile).toBeNull()
  })
})

describe('enforcePinned', () => {
  const previous = '## Pinned\n\n- Never use em-dashes.\n\n## Active projects\n\n- Old project.'

  it('restores the Pinned section when the rewrite dropped it', () => {
    const next = enforcePinned(previous, '## Active projects\n\n- New project.')
    expect(next).toContain('## Pinned')
    expect(next).toContain('- Never use em-dashes.')
    expect(next).toContain('- New project.')
  })

  it('overwrites a Pinned section the rewrite altered', () => {
    const next = enforcePinned(previous, '## Pinned\n\n- Em-dashes are fine now.\n\n## Active projects\n\n- New.')
    expect(next).toContain('- Never use em-dashes.')
    expect(next).not.toContain('Em-dashes are fine now.')
  })

  it('leaves the rewrite alone when there was no previous Pinned section', () => {
    const next = enforcePinned('## Active projects\n\n- Old.', '## Active projects\n\n- New.')
    expect(next).toBe('## Active projects\n\n- New.')
  })

  it('does not resurrect an empty previous Pinned section', () => {
    const next = enforcePinned('## Pinned\n\n## Active projects\n\n- Old.', '## Active projects\n\n- New.')
    expect(next).not.toContain('## Pinned')
  })
})

describe('enforceBudget', () => {
  const long = (label: string, n: number) =>
    `## ${label}\n\n` + Array.from({ length: n }, (_, i) => `- ${label} entry number ${i} with some descriptive text.`).join('\n')

  it('leaves a document within budget untouched', () => {
    const content = long('Active projects', 3)
    expect(enforceBudget(content, 1500)).toBe(content)
  })

  it('tolerates a small overshoot rather than cutting mid-document', () => {
    const content = [long('Active projects', 10), long('Open threads', 10)].join('\n\n')
    // Budget chosen so the document sits at ~1.1x it: over budget, but inside
    // the 1.2 tolerance, so both sections must survive.
    const budget = Math.ceil(countTokens(content) / 1.1)
    expect(enforceBudget(content, budget)).toBe(content)
  })

  it('returns the document unchanged when a single section is over budget', () => {
    const content = long('Active projects', 40)
    expect(enforceBudget(content, 20)).toBe(content)
  })

  it('drops trailing sections when the overshoot is large', () => {
    const content = [long('Pinned', 2), long('Active projects', 40), long('Open threads', 40)].join('\n\n')
    const trimmed = enforceBudget(content, 60)
    expect(trimmed).toContain('## Pinned')
    expect(trimmed.length).toBeLessThan(content.length)
  })

  it('keeps Pinned even when it is the last section', () => {
    const content = [long('Active projects', 40), long('Open threads', 40), long('Pinned', 2)].join('\n\n')
    const trimmed = enforceBudget(content, 60)
    expect(trimmed).toContain('## Pinned')
    expect(trimmed).toContain('Pinned entry number 0')
  })

  it('is a no-op when no budget is set', () => {
    const content = long('Active projects', 200)
    expect(enforceBudget(content, 0)).toBe(content)
  })
})

describe('selectArchiveIndex', () => {
  const entry = (id: string, dayOffset: number, subject: string | null = null) => ({
    id,
    content: `memory ${id}`,
    category: 'fact',
    subject,
    updatedAt: new Date(2026, 0, 1 + dayOffset),
  })

  it('returns everything, newest first, when the archive fits', () => {
    const all = [entry('a', 0), entry('c', 2), entry('b', 1)]
    expect(selectArchiveIndex(all, 'anything', 10).map((e) => e.id)).toEqual(['c', 'b', 'a'])
  })

  it('keeps only the most recent entries when the archive is too large', () => {
    const all = Array.from({ length: 20 }, (_, i) => entry(`m${i}`, i))
    const picked = selectArchiveIndex(all, 'unrelated text', 5)
    expect(picked).toHaveLength(5)
    expect(picked.map((e) => e.id)).toEqual(['m19', 'm18', 'm17', 'm16', 'm15'])
  })

  it('pulls in an old memory whose subject the batch talks about', () => {
    const all = [
      ...Array.from({ length: 20 }, (_, i) => entry(`m${i}`, i + 5)),
      entry('ancient', 0, 'Soupçon de Magie'),
    ]
    const picked = selectArchiveIndex(all, 'We discussed Soupçon de Magie invoicing today.', 5)
    expect(picked.map((e) => e.id)).toContain('ancient')
  })

  it('matches subjects case-insensitively', () => {
    const all = [
      ...Array.from({ length: 20 }, (_, i) => entry(`m${i}`, i + 5)),
      entry('ancient', 0, 'KinBot'),
    ]
    const picked = selectArchiveIndex(all, 'a question about kinbot deployment', 5)
    expect(picked.map((e) => e.id)).toContain('ancient')
  })

  it('caps subject matches at half the budget so recent entries still get in', () => {
    const all = Array.from({ length: 40 }, (_, i) => entry(`s${i}`, i, 'kinbot'))
    const picked = selectArchiveIndex(all, 'all about kinbot', 10)
    expect(picked).toHaveLength(10)
    // The newest entries are present even though every memory matches the subject.
    expect(picked.map((e) => e.id)).toContain('s39')
  })

  it('never exceeds the limit', () => {
    const all = Array.from({ length: 500 }, (_, i) => entry(`m${i}`, i, 'kinbot'))
    expect(selectArchiveIndex(all, 'kinbot kinbot kinbot', 150)).toHaveLength(150)
  })

  it('ignores an empty subject rather than matching everything', () => {
    const all = [
      ...Array.from({ length: 20 }, (_, i) => entry(`m${i}`, i + 5)),
      entry('blank', 0, '   '),
    ]
    expect(selectArchiveIndex(all, 'any text at all', 5).map((e) => e.id)).not.toContain('blank')
  })
})

describe('buildMaintenancePrompt', () => {
  it('states the shared boundary test and the token budget', () => {
    const prompt = buildMaintenancePrompt({
      currentProfile: '## Pinned\n\n- Keep me.',
      summary: 'They discussed the memory redesign.',
      existingMemoriesSummary: '[0] [fact] Something known',
      formattedMessages: '[user] hello',
      budget: 1500,
    })
    expect(prompt).toContain(BOUNDARY_TEST)
    expect(prompt).toContain('Stay under 1500 tokens')
    expect(prompt).toContain('- Keep me.')
    expect(prompt).toContain('They discussed the memory redesign.')
    expect(prompt).toContain('[0] [fact] Something known')
    expect(prompt).toContain('[user] hello')
  })

  it('tells the model to build a profile from scratch when there is none', () => {
    const prompt = buildMaintenancePrompt({
      currentProfile: '   ',
      summary: 's',
      existingMemoriesSummary: '(none)',
      formattedMessages: '[user] hi',
      budget: 1500,
    })
    expect(prompt).toContain('(empty — build it from what you learn here)')
  })
})
