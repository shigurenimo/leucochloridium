import type { CredentialStore } from "@/secrets/credential-store"
import { slackCredentialsSchema } from "@/secrets/slack-credentials"
import type { SlackCredentials } from "@/secrets/slack-credentials"

export async function loadSlackCredentials(
  store: CredentialStore,
  name: string,
): Promise<SlackCredentials> {
  const secret = await store.get(name)
  if (secret === null)
    throw new Error("Slack credentials are missing. Stop Leuco and run leuco slack login.")
  try {
    return slackCredentialsSchema.parse(JSON.parse(secret))
  } catch {
    throw new Error("Slack credentials are invalid. Stop Leuco and run leuco slack login.")
  }
}
