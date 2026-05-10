/**
 * Compute a stable display name for a contact from its base fields.
 * Order of preference: "First Last" → first nickname → "Unnamed contact".
 */
export function getContactDisplayName(c: {
  firstName?: string | null
  lastName?: string | null
  nicknames?: ReadonlyArray<string | { nickname: string }> | null
}): string {
  const parts: string[] = []
  if (c.firstName?.trim()) parts.push(c.firstName.trim())
  if (c.lastName?.trim()) parts.push(c.lastName.trim())
  if (parts.length > 0) return parts.join(' ')

  const first = c.nicknames?.[0]
  if (first) {
    const nick = typeof first === 'string' ? first : first.nickname
    if (nick?.trim()) return nick.trim()
  }

  return 'Unnamed contact'
}
