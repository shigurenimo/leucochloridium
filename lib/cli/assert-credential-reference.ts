import { CHAT_PROVIDERS } from "@/cli/chat-providers"
import type { ChatProvider } from "@/cli/chat-providers"
import { CliError } from "@/cli/cli-error"
import type { LeucoSettings } from "@/config/config-schema"

export function assertCredentialReference(
  settings: LeucoSettings,
  provider: ChatProvider,
  expected: string | null,
): void {
  const current = settings[provider]?.credential ?? null
  if (current === expected) return
  throw new CliError(
    "STATE_CONFLICT",
    `${CHAT_PROVIDERS[provider].name} credential reference changed from ${expected ?? "(none)"} to ${current ?? "(none)"}; inspect current config before retrying`,
    { phase: "credential-reference", expectedCredential: expected, currentCredential: current },
  )
}
