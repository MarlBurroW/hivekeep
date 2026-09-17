import { describe, it, expect } from 'bun:test'
import {
  parseSections,
  serializeSections,
  applyProfileEdit,
  ProfileLineNotFoundError,
  isEditAllowedByBudget,
} from '@/server/services/agent-profile'
import { countTokens } from '@/shared/token-estimator'

const SAMPLE = `## Pinned

- GitHub issues are always written in English.

## Active projects

- Hivekeep promo campaign: site tour page shipped, video next.
- Soupçon de Magie: Square migration, VAT at 20%.

## Open threads

- Decide on the AGPL vs MIT license.`

describe('parseSections', () => {
  it('splits a document into its ## sections', () => {
    const sections = parseSections(SAMPLE)
    expect(sections.map((s) => s.title)).toEqual(['Pinned', 'Active projects', 'Open threads'])
    expect(sections[1]!.lines.join('\n')).toContain('Hivekeep promo campaign')
  })

  it('preserves content written before the first heading', () => {
    const sections = parseSections('Loose intro line.\n\n## Pinned\n\n- One')
    expect(sections[0]!.title).toBe('')
    expect(sections[0]!.lines.join('\n')).toContain('Loose intro line.')
    expect(sections[1]!.title).toBe('Pinned')
  })

  it('round-trips through serializeSections', () => {
    expect(serializeSections(parseSections(SAMPLE))).toBe(SAMPLE)
  })
})

describe('applyProfileEdit', () => {
  it('appends a line to an existing section', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'Open threads',
      operation: 'append',
      content: '- Ship the memory v2 UI.',
    })
    const threads = parseSections(next).find((s) => s.title === 'Open threads')!
    expect(threads.lines.join('\n')).toContain('Decide on the AGPL vs MIT license.')
    expect(threads.lines.join('\n')).toContain('Ship the memory v2 UI.')
  })

  it('creates the section when appending to one that does not exist', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'Preferences & conventions',
      operation: 'append',
      content: '- Prefers concise answers.',
    })
    const titles = parseSections(next).map((s) => s.title)
    expect(titles).toContain('Preferences & conventions')
    expect(next).toContain('- Prefers concise answers.')
  })

  it('matches an existing section case-insensitively instead of duplicating it', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'active projects',
      operation: 'append',
      content: '- New project.',
    })
    const projectSections = parseSections(next).filter(
      (s) => s.title.toLowerCase() === 'active projects',
    )
    expect(projectSections).toHaveLength(1)
  })

  it('routes to Pinned when pin is set, ignoring the requested section', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'Open threads',
      operation: 'append',
      content: '- Never use em-dashes.',
      pin: true,
    })
    const pinned = parseSections(next).find((s) => s.title === 'Pinned')!
    expect(pinned.lines.join('\n')).toContain('Never use em-dashes.')
    const threads = parseSections(next).find((s) => s.title === 'Open threads')!
    expect(threads.lines.join('\n')).not.toContain('Never use em-dashes.')
  })

  it('replaces a section body wholesale', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'Open threads',
      operation: 'replace_section',
      content: '- Only one thread left.',
    })
    const threads = parseSections(next).find((s) => s.title === 'Open threads')!
    expect(threads.lines.join('\n').trim()).toBe('- Only one thread left.')
    expect(next).not.toContain('AGPL vs MIT')
  })

  it('removes a line, matching with or without the list bullet', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'Active projects',
      operation: 'remove_line',
      content: 'Soupçon de Magie: Square migration, VAT at 20%.',
    })
    expect(next).not.toContain('Soupçon de Magie')
    expect(next).toContain('Hivekeep promo campaign')
  })

  it('drops the heading when removing the section last line', () => {
    const next = applyProfileEdit(SAMPLE, {
      section: 'Open threads',
      operation: 'remove_line',
      content: '- Decide on the AGPL vs MIT license.',
    })
    expect(parseSections(next).map((s) => s.title)).toEqual(['Pinned', 'Active projects'])
  })

  it('throws when the line to remove is absent', () => {
    expect(() =>
      applyProfileEdit(SAMPLE, {
        section: 'Active projects',
        operation: 'remove_line',
        content: '- A line that was never there.',
      }),
    ).toThrow(ProfileLineNotFoundError)
  })

  it('throws when removing from a section that does not exist', () => {
    expect(() =>
      applyProfileEdit(SAMPLE, {
        section: 'Nonexistent',
        operation: 'remove_line',
        content: '- Anything.',
      }),
    ).toThrow(ProfileLineNotFoundError)
  })

  it('builds a document from empty content', () => {
    const next = applyProfileEdit('', {
      section: 'Active projects',
      operation: 'append',
      content: '- First project.',
    })
    expect(next).toBe('## Active projects\n\n- First project.')
  })
})

describe('isEditAllowedByBudget', () => {
  const small = '## Active projects\n\n- One short line.'
  const big = '## Active projects\n\n' + Array.from({ length: 200 }, (_, i) => `- Entry number ${i} with descriptive text.`).join('\n')

  it('allows an edit that stays within budget', () => {
    expect(isEditAllowedByBudget(small, small + '\n- Another line.', 1500)).toBe(true)
  })

  it('refuses an edit that pushes an in-budget profile over it', () => {
    expect(isEditAllowedByBudget(small, big, 100)).toBe(false)
  })

  it('allows shrinking an over-budget profile even while it stays over', () => {
    const slightlySmaller = big.split('\n').slice(0, -20).join('\n')
    expect(countTokens(slightlySmaller)).toBeGreaterThan(100)
    expect(isEditAllowedByBudget(big, slightlySmaller, 100)).toBe(true)
  })

  it('refuses growing a profile that is already over budget', () => {
    expect(isEditAllowedByBudget(big, big + '\n- One more entry.', 100)).toBe(false)
  })

  it('is a no-op when no budget is configured', () => {
    expect(isEditAllowedByBudget(small, big, 0)).toBe(true)
  })
})
