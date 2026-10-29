import type { CredentialStore } from "@/secrets/credential-store"
import { slackCredentialDraftSchema } from "@/secrets/slack-credentials"
import type { SlackCredentialDraft } from "@/secrets/slack-credentials"

export async function readSlackCredentialDraft(
  store: CredentialStore,
  reference: string | null,
): Promise<SlackCredentialDraft> {
  if (reference === null) return {}
  const stored = await store.get(reference)
  if (stored === null) return {}
  try {
    return slackCredentialDraftSchema.parse(JSON.parse(stored))
  } catch {
    throw new Error(
      "Saved Slack credentials are invalid. Run leuco slack logout, then register each token from the clipboard again.",
    )
  }
}
