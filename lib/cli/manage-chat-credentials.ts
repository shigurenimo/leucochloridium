import { randomUUID } from "node:crypto"
import { assertCredentialReference } from "@/cli/assert-credential-reference"
import { CHAT_PROVIDERS } from "@/cli/chat-providers"
import type { ChatProvider } from "@/cli/chat-providers"
import { CliError } from "@/cli/cli-error"
import { handleCredentialSaveFailure } from "@/cli/handle-credential-save-failure"
import { logoutChatCredentials } from "@/cli/logout-chat-credentials"
import { readTokenFromClipboard } from "@/cli/read-token-from-clipboard"
import type { Clipboard } from "@/clipboard/clipboard"
import { errorDetails } from "@/error-details"
import type { CredentialStore } from "@/secrets/credential-store"
import type { LeucoStore } from "@/storage/leuco-store"

type Props = {
  store: LeucoStore
  credentials: CredentialStore
  provider: ChatProvider
  signal?: AbortSignal
} & ({ action: "login"; kind: string; clipboard: Clipboard } | { action: "logout" })

export async function manageChatCredentials(props: Props): Promise<unknown> {
  const definition = CHAT_PROVIDERS[props.provider]
  const previous = props.store.loadSettings()[props.provider]?.credential ?? null
  if (props.action === "logout")
    return logoutChatCredentials({
      store: props.store,
      credentials: props.credentials,
      provider: props.provider,
      previous,
    })
  const token = definition.tokens.find((entry) => entry.kind === props.kind)
  if (token === undefined)
    throw new CliError("USAGE", `${definition.name} has no ${props.kind} token`)
  const value = await readTokenFromClipboard({
    clipboard: props.clipboard,
    provider: props.provider,
    token,
    signal: props.signal,
  })
  const draft = await definition.readDraft(props.credentials, previous)
  const saved = { ...draft, [token.field]: value }
  const missing = definition.tokens
    .filter((entry) => !saved[entry.field])
    .map((entry) => entry.kind)
  props.signal?.throwIfAborted()
  const credential = randomUUID()
  try {
    await props.credentials.set(credential, JSON.stringify(saved))
    props.signal?.throwIfAborted()
    props.store.updateSettings((settings) => {
      assertCredentialReference(settings, props.provider, previous)
      return definition.withCredential(settings, credential)
    })
  } catch (error) {
    await handleCredentialSaveFailure({
      store: props.store,
      credentials: props.credentials,
      credential,
      previous,
      setting: props.provider,
      failure: error,
    })
  }
  const outcome = definition.toLoginResult(token.kind, missing)
  if (previous !== null) {
    try {
      assertCredentialReference(props.store.loadSettings(), props.provider, credential)
      await props.credentials.delete(previous)
    } catch (cause) {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `New ${definition.name} credential ${credential} was saved in settings, but removal of previous OS credential ${previous} could not be confirmed. Inspect current config and error details before repeating login.`,
        {
          phase: "credential-cleanup",
          settingsSaved: true,
          deletionConfirmed: false,
          credential,
          previousCredential: previous,
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
