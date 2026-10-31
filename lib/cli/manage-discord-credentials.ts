import { readDiscordTokenFromClipboard } from "@/cli/read-discord-token-from-clipboard"
import { assertDiscordCredentialReference } from "@/cli/assert-discord-credential-reference"
import { errorDetails } from "@/error-details"
import { handleCredentialSaveFailure } from "@/cli/handle-credential-save-failure"
import { logoutDiscordCredentials } from "@/cli/logout-discord-credentials"
import { randomUUID } from "node:crypto"
import type { LeucoStore } from "@/storage/leuco-store"
import type { CredentialStore } from "@/secrets/credential-store"
import type { Clipboard } from "@/clipboard/clipboard"
import { CliError } from "@/cli/cli-error"

type Props = {
  store: LeucoStore
  credentials: CredentialStore
  signal?: AbortSignal
} & ({ action: "login"; clipboard: Clipboard } | { action: "logout" })

export async function manageDiscordCredentials(props: Props): Promise<unknown> {
  const previous = props.store.loadSettings().discord
  if (props.action === "logout")
    return logoutDiscordCredentials({ ...props, previous: previous?.credential ?? null })
  const token = await readDiscordTokenFromClipboard(props.clipboard, props.signal)
  const saved = { botToken: token }
  props.signal?.throwIfAborted()
  const credential = randomUUID()
  try {
    await props.credentials.set(credential, JSON.stringify(saved))
    props.signal?.throwIfAborted()
    props.store.updateSettings((settings) => {
      assertDiscordCredentialReference(settings, previous?.credential ?? null)
      return {
        ...settings,
        discord: { credential, messageContent: settings.discord?.messageContent ?? true },
      }
    })
  } catch (error) {
    await handleCredentialSaveFailure({
      store: props.store,
      credentials: props.credentials,
      credential,
      previous: previous?.credential ?? null,
      failure: error,
      setting: "discord",
    })
  }
  const outcome = {
    discord: "saved in OS credential store",
    complete: true,
    restartRequired: true,
  }
  if (previous !== null) {
    try {
      assertDiscordCredentialReference(props.store.loadSettings(), credential)
      await props.credentials.delete(previous.credential)
    } catch (cause) {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `New Discord credential ${credential} was saved in settings, but removal of previous OS credential ${previous.credential} could not be confirmed. Inspect current config and error details before repeating login.`,
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
