import { randomUUID } from "node:crypto"
import type { LeucoStore } from "@/storage/leuco-store"
import type { CredentialStore } from "@/secrets/credential-store"
import type { SecretPrompt } from "@/cli/secret-prompt"
import { slackCredentialsSchema } from "@/secrets/slack-credentials"

type Props = {
  action: "login" | "logout"
  store: LeucoStore
  credentials: CredentialStore
  prompt: SecretPrompt
}

export async function manageSlackCredentials(props: Props): Promise<unknown> {
  const previous = props.store.loadSettings().slack
  if (props.action === "logout") {
    if (previous !== null) await props.credentials.delete(previous.credential)
    props.store.updateSettings((settings) => ({ ...settings, slack: null }))
    return { slack: "logged out" }
  }
  const botToken = await props.prompt.read("Slack bot token (hidden): ")
  const appToken = await props.prompt.read("Slack app token (hidden): ")
  const parsed = slackCredentialsSchema.safeParse({ botToken, appToken })
  if (!parsed.success)
    throw new Error(
      "Enter a Slack bot token (xox...) and app token (xapp-...), each at most 1024 characters.",
    )
  const credential = randomUUID()
  await props.credentials.set(credential, JSON.stringify(parsed.data))
  try {
    props.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential, ackMode: settings.slack?.ackMode ?? "mention" },
    }))
  } catch (error) {
    await props.credentials.delete(credential).catch(() => {})
    throw error
  }
  if (previous !== null) await props.credentials.delete(previous.credential)
  return { slack: "saved in OS credential store", restartRequired: true }
}
