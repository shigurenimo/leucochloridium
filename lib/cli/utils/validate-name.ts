const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

/**
 * Check that a project / agent / channel name matches `^[a-z][a-z0-9_-]*$`,
 * the same shape `safeName` enforces in the zod schema. Returns the name on
 * success or an `Error` describing why it was rejected.
 */
export const validateLeucoName = (name: string, label: string): string | Error => {
  if (name.length === 0) return new Error(`${label}: must not be empty`)
  if (!NAME_PATTERN.test(name)) {
    return new Error(`${label}: must match ^[a-z][a-z0-9_-]*$ (got "${name}")`)
  }
  return name
}
