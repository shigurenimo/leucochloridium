import { readSlackTokenFromClipboard } from "@/cli/read-slack-token-from-clipboard"
import { assertSlackCredentialReference } from "@/cli/assert-slack-credential-reference"
import { errorDetails } from "@/error-details"
import { readSlackCredentialDraft } from "@/secrets/read-slack-credential-draft"
import { handleCredentialSaveFailure } from "@/cli/handle-credential-save-failure"
import { logoutSlackCredentials } from "@/cli/logout-slack-credentials"
import { randomUUID } from "node:crypto"
import type { LeucoStore } from "@/storage/leuco-store"
import type { CredentialStore } from "@/secrets/credential-store"
import type { Clipboard } from "@/clipboard/clipboard"
import { CliError } from "@/cli/cli-error"

type Props = {
  store: LeucoStore
  credentials: CredentialStore
  signal?: AbortSignal
} & ({ action: "login"; kind: "bot" | "app"; clipboard: Clipboard } | { action: "logout" })

export async function manageSlackCredentials(props: Props): Promise<unknown> {
  const previous = props.store.loadSettings().slack
  if (props.action === "logout")
    return logoutSlackCredentials({ ...props, previous: previous?.credential ?? null })
  const token = await readSlackTokenFromClipboard(props.clipboard, props.kind, props.signal)
  const draft = await readSlackCredentialDraft(props.credentials, previous?.credential ?? null)
  const saved = { ...draft, [props.kind === "bot" ? "botToken" : "appToken"]: token }
  const missing: string[] = []
  if (!saved.botToken) missing.push("bot")
  if (!saved.appToken) missing.push("app")
  props.signal?.throwIfAborted()
  const credential = randomUUID()
  try {
    await props.credentials.set(credential, JSON.stringify(saved))
    props.signal?.throwIfAborted()
    props.store.updateSettings((settings) => {
      assertSlackCredentialReference(settings, previous?.credential ?? null)
      return { ...settings, slack: { credential, ackMode: settings.slack?.ackMode ?? "mention" } }
    })
  } catch (error) {
    await handleCredentialSaveFailure({
      store: props.store,
      credentials: props.credentials,
      credential,
      previous: previous?.credential ?? null,
      failure: error,
    })
  }
  const outcome = {
    slack: "saved in OS credential store",
    saved: props.kind,
    complete: missing.length === 0,
    missing,
    restartRequired: true,
  }
  if (previous !== null) {
    try {
      assertSlackCredentialReference(props.store.loadSettings(), credential)
      await props.credentials.delete(previous.credential)
    } catch (cause) {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `New Slack credential ${credential} was saved in settings, but removal of previous OS credential ${previous.credential} could not be confirmed. Inspect current config and error details before repeating login.`,
        {
          phase: "credential-cleanup",
          settingsSaved: true,
          deletionConfirmed: false,
          credential,
          previousCredential: previous.credential,
          ...outcome,
          causes: errorDetails(cause),
        },
      )
      failure.cause = cause
      throw failure
    }
  }
  return outcome
}
