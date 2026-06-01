import { describe, it, expect } from 'bun:test'
import { parseVCard, vcardToContact, contactMatches } from '@/server/contacts/providers/icloud'

// A realistic iCloud vCard 3.0: grouped properties (item1.TEL), folded line,
// escaped comma in ORG, mixed phone/email types.
const VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Varrot;Nicolas;;;',
  'FN:Nicolas Varrot',
  'ORG:Acme\\, Inc.;',
  'item1.TEL;type=CELL;type=VOICE;type=pref:+33 6 12 34 56 78',
  'TEL;type=HOME;type=VOICE:+33 1 23 45 67 89',
  'item2.EMAIL;type=INTERNET;type=HOME:nico@example.co',
  ' m',
  'END:VCARD',
].join('\r\n')

describe('parseVCard', () => {
  const p = parseVCard(VCARD)

  it('reads FN and N', () => {
    expect(p.fn).toBe('Nicolas Varrot')
    expect(p.given).toBe('Nicolas')
    expect(p.family).toBe('Varrot')
  })

  it('unescapes ORG and takes the first component', () => {
    expect(p.org).toBe('Acme, Inc.')
  })

  it('strips group prefixes and normalizes phone types', () => {
    expect(p.phones).toEqual([
      { number: '+33 6 12 34 56 78', type: 'mobile' },
      { number: '+33 1 23 45 67 89', type: 'home' },
    ])
  })

  it('unfolds a folded EMAIL value', () => {
    expect(p.emails).toEqual([{ email: 'nico@example.com', type: 'home' }])
  })
})

describe('vcardToContact', () => {
  it('builds a Contact, falling back to N when FN is absent', () => {
    const c = vcardToContact('https://x/card/1.vcf', 'BEGIN:VCARD\nN:Doe;Jane;;;\nTEL:+15551234567\nEND:VCARD', 'Card')
    expect(c.id).toBe('https://x/card/1.vcf')
    expect(c.displayName).toBe('Jane Doe')
    expect(c.phones).toEqual([{ number: '+15551234567', type: undefined }])
    expect(c.addressBook).toBe('Card')
  })

  it('uses a placeholder when there is no name at all', () => {
    expect(vcardToContact('u', 'BEGIN:VCARD\nEND:VCARD').displayName).toBe('(no name)')
  })
})

describe('contactMatches', () => {
  const c = vcardToContact('u', VCARD, 'Card')

  it('matches on name (case-insensitive)', () => {
    expect(contactMatches(c, 'nicolas')).toBe(true)
    expect(contactMatches(c, 'VARROT')).toBe(true)
  })

  it('matches on organization and email', () => {
    expect(contactMatches(c, 'acme')).toBe(true)
    expect(contactMatches(c, 'example.com')).toBe(true)
  })

  it('matches on phone digits ignoring formatting', () => {
    expect(contactMatches(c, '612345678')).toBe(true)
    expect(contactMatches(c, '612 345')).toBe(true)
  })

  it('does not match an unrelated term', () => {
    expect(contactMatches(c, 'zzz')).toBe(false)
  })

  it('matches everything on an empty term', () => {
    expect(contactMatches(c, '')).toBe(true)
  })
})
