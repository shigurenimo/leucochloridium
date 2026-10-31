import { CliError } from "@/cli/cli-error"
import type { LeucoSettings } from "@/config/config-schema"

export function assertDiscordCredentialReference(
  settings: LeucoSettings,
  expected: string | null,
): void {
  const current = settings.discord?.credential ?? null
  if (current === expected) return
  throw new CliError(
    "STATE_CONFLICT",
    `Discord credential reference changed from ${expected ?? "(none)"} to ${current ?? "(none)"}; inspect current config before retrying`,
    { phase: "credential-reference", expectedCredential: expected, currentCredential: current },
  )
}
