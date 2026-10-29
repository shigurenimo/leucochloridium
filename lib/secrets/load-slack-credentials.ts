import type { CredentialStore } from "@/secrets/credential-store"
import { slackCredentialsSchema, slackCredentialDraftSchema } from "@/secrets/slack-credentials"
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
  const decoded = (() => {
    try {
      return slackCredentialDraftSchema.safeParse(JSON.parse(secret))
    } catch {
      return null
    }
  })()
  if (decoded === null || !decoded.success)
    throw new Error(
      "Slack credentials are invalid. Run leuco slack logout, then register each token from the clipboard again.",
    )
  const missing = [
    !decoded.data.botToken ? "bot" : null,
    !decoded.data.appToken ? "app" : null,
  ].filter((kind) => kind !== null)
  if (missing.length > 0)
    throw new Error(
      `Slack credentials are incomplete. Copy the missing token and run ${missing.map((kind) => `leuco slack login ${kind}`).join(" and ")}.`,
    )
  return slackCredentialsSchema.parse(decoded.data)
}
