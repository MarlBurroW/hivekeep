import { describe, it, expect } from 'bun:test'
import { buildCompilePrompt } from '@/server/services/agent-profile-bootstrap'
import { BOUNDARY_TEST } from '@/server/services/memory-maintenance'

const BASE = {
  agentName: 'Kube Master',
  agentRole: 'infrastructure expert',
  memoriesList: '- [fact] (kinbot) Runs as a systemd user service — last updated 2026-07-01',
  currentProfile: '',
  budget: 1500,
}

describe('buildCompilePrompt', () => {
  it('applies the same boundary test as the maintenance call', () => {
    expect(buildCompilePrompt(BASE)).toContain(BOUNDARY_TEST)
  })

  it('includes the agent identity, the archive and the budget', () => {
    const prompt = buildCompilePrompt(BASE)
    expect(prompt).toContain('Kube Master')
    expect(prompt).toContain('infrastructure expert')
    expect(prompt).toContain('Runs as a systemd user service')
    expect(prompt).toContain('Stay under 1500 tokens')
  })

  it('tells the model the archive stays searchable, so it need not be copied', () => {
    expect(buildCompilePrompt(BASE)).toContain('The archive stays searchable')
  })

  it('omits the preservation instruction when there is no existing profile', () => {
    const prompt = buildCompilePrompt(BASE)
    expect(prompt).not.toContain('## Current profile')
    expect(prompt).not.toContain('Preserve everything already in the current profile')
  })

  it('asks to preserve an existing profile, Pinned included', () => {
    const prompt = buildCompilePrompt({
      ...BASE,
      currentProfile: '## Pinned\n\n- Never use em-dashes.',
    })
    expect(prompt).toContain('## Current profile')
    expect(prompt).toContain('- Never use em-dashes.')
    expect(prompt).toContain('especially "## Pinned"')
  })
})
