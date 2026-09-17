/** Parse numeric configuration without ever echoing supplied values in errors. */
export function envNumber(
  name: string,
  fallback: number,
  options: { min?: number; max?: number; integer?: boolean; legacyZeroDefault?: boolean } = {},
): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  const { min = 0, max = 2_147_483_647, integer = true } = options
  if (raw.trim() === '' || !Number.isFinite(value) || value < min || value > max
    || (integer && !Number.isInteger(value))) {
    throw new Error(`Invalid configuration: ${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`)
  }
  if (value === 0 && options.legacyZeroDefault) {
    console.warn(`${name}=0 now uses the finite default limit; set a positive limit to override it`)
    return fallback
  }
  return value
}
