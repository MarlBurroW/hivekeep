import { describe, it, expect } from 'bun:test'
import { parseTicketRef, ticketResolutionMessage } from './ticket-ref'

describe('parseTicketRef', () => {
  describe('UUID legacy', () => {
    it('parses a v4 uuid', () => {
      const ref = parseTicketRef('9ba56654-c252-4a23-afa9-d6d227f2d05b')
      expect(ref).toEqual({ kind: 'uuid', id: '9ba56654-c252-4a23-afa9-d6d227f2d05b' })
    })
    it('trims whitespace', () => {
      const ref = parseTicketRef('  9ba56654-c252-4a23-afa9-d6d227f2d05b\n')
      expect(ref.kind).toBe('uuid')
    })
  })

  describe('qualified slug#number', () => {
    it('parses kinbot#42', () => {
      expect(parseTicketRef('kinbot#42')).toEqual({ kind: 'qualified', slug: 'kinbot', number: 42 })
    })
    it('parses a slug with hyphens', () => {
      expect(parseTicketRef('soupcon-de-magie#1')).toEqual({
        kind: 'qualified',
        slug: 'soupcon-de-magie',
        number: 1,
      })
    })
    it('rejects an empty number', () => {
      expect(parseTicketRef('kinbot#').kind).toBe('invalid')
    })
    it('rejects a slug starting with a digit', () => {
      expect(parseTicketRef('1kinbot#42').kind).toBe('invalid')
    })
    it('rejects uppercase in slug', () => {
      expect(parseTicketRef('KinBot#42').kind).toBe('invalid')
    })
  })

  describe('bare number', () => {
    it('parses #42', () => {
      expect(parseTicketRef('#42')).toEqual({ kind: 'bare', number: 42 })
    })
    it('parses 42 without prefix', () => {
      expect(parseTicketRef('42')).toEqual({ kind: 'bare', number: 42 })
    })
    it('rejects zero', () => {
      expect(parseTicketRef('#0').kind).toBe('invalid')
    })
    it('rejects negative numbers', () => {
      expect(parseTicketRef('-42').kind).toBe('invalid')
    })
  })

  describe('invalid', () => {
    it('flags empty string', () => {
      expect(parseTicketRef('')).toEqual({ kind: 'invalid', raw: '' })
    })
    it('flags whitespace only', () => {
      expect(parseTicketRef('   ').kind).toBe('invalid')
    })
    it('flags random text', () => {
      expect(parseTicketRef('foo bar').kind).toBe('invalid')
    })
    it('flags slug without number', () => {
      expect(parseTicketRef('kinbot').kind).toBe('invalid')
    })
  })
})

describe('ticketResolutionMessage', () => {
  it('formats INVALID_TICKET_REF with the raw input', () => {
    expect(ticketResolutionMessage('INVALID_TICKET_REF', { raw: 'foo bar' })).toContain('"foo bar"')
  })
  it('formats PROJECT_NOT_FOUND with the slug', () => {
    expect(ticketResolutionMessage('PROJECT_NOT_FOUND', { slug: 'kinbot' })).toContain("'kinbot'")
  })
  it('formats TICKET_NOT_FOUND with project + number', () => {
    const msg = ticketResolutionMessage('TICKET_NOT_FOUND', { slug: 'kinbot', number: 42 })
    expect(msg).toContain('#42')
    expect(msg).toContain("'kinbot'")
  })
  it('mentions set_active_project on NO_ACTIVE_PROJECT', () => {
    const msg = ticketResolutionMessage('NO_ACTIVE_PROJECT')
    expect(msg).toContain('set_active_project')
    expect(msg).toContain('projectSlug#number')
  })
})
