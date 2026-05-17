const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

/**
 * Check that a project / agent / channel name matches `^[a-z][a-z0-9_-]*$`,
 * the same shape `safeName` enforces in the zod schema. Throws when the name
 * is rejected so callers do not need to branch on the return value.
 */
export const validateLeucoName = (name: string, label: string): string => {
  if (name.length === 0) throw new Error(`${label}: must not be empty`)
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`${label}: must match ^[a-z][a-z0-9_-]*$ (got "${name}")`)
  }
  return name
}
