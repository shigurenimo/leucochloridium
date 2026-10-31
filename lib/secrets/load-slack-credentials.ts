import type { CredentialStore } from "@/secrets/credential-store"
import { slackCredentialsSchema } from "@/secrets/slack-credentials"
import { parseSlackCredentialDraft } from "@/secrets/read-slack-credential-draft"
import type { SlackCredentials } from "@/secrets/slack-credentials"

export async function loadSlackCredentials(
  store: CredentialStore,
  name: string,
): Promise<SlackCredentials> {
  const secret = await store.get(name)
  if (secret === null)
    throw new Error(
      "Slack credentials are missing. Copy each token and run leuco slack login bot and leuco slack login app.",
    )
  const draft = parseSlackCredentialDraft(secret)
  const missing = [!draft.botToken ? "bot" : null, !draft.appToken ? "app" : null].filter(
    (kind) => kind !== null,
  )
  if (missing.length > 0)
    throw new Error(
      `Slack credentials are incomplete. Copy the missing token and run ${missing.map((kind) => `leuco slack login ${kind}`).join(" and ")}.`,
    )
  return slackCredentialsSchema.parse(draft)
}
