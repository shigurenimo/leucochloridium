import { validateLeucoName } from "@/cli/utils/validate-name"

/**
 * CLI grammar words that must not be used as project / channel names: a
 * project named `list` resolves to `leuco projects list` (the listing
 * handler) forever, making the project unreachable from the CLI. Keep in
 * sync with the leaf sets in `lib/cli/utils/to-request.ts`.
 */
const RESERVED_NAMES = new Set(["list", "create", "add", "channels", "session", "schedules"])

export const assertRoutableName = (name: string, label: string): string => {
  validateLeucoName(name, label)

  if (RESERVED_NAMES.has(name)) {
    throw new Error(`${label}: "${name}" is a reserved CLI word and cannot be used`)
  }
  return name
}
