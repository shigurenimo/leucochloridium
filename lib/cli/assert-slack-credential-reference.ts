import { CliError } from "@/cli/cli-error"
import type { LeucoSettings } from "@/config/config-schema"

export function assertSlackCredentialReference(
  settings: LeucoSettings,
  expected: string | null,
): void {
  const current = settings.slack?.credential ?? null
  if (current === expected) return
  throw new CliError(
    "STATE_CONFLICT",
    `Slack credential reference changed from ${expected ?? "(none)"} to ${current ?? "(none)"}; inspect current config before retrying`,
    { phase: "credential-reference", expectedCredential: expected, currentCredential: current },
  )
}
