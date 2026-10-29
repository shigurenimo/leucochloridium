import { readSlackCredentialDraft } from "@/secrets/read-slack-credential-draft"
import { randomUUID } from "node:crypto"
import type { LeucoStore } from "@/storage/leuco-store"
import type { CredentialStore } from "@/secrets/credential-store"
import type { Clipboard } from "@/clipboard/clipboard"
import { ClipboardReadError } from "@/clipboard/clipboard-read-error"
import { CliError } from "@/cli/cli-error"
import { slackCredentialsSchema } from "@/secrets/slack-credentials"

type Props = {
  store: LeucoStore
  credentials: CredentialStore
  clipboard: Clipboard
  signal?: AbortSignal
} & ({ action: "login"; kind: "bot" | "app" } | { action: "logout" })

export async function manageSlackCredentials(props: Props): Promise<unknown> {
  const previous = props.store.loadSettings().slack
  if (props.action === "logout") {
    if (previous !== null) await props.credentials.delete(previous.credential)
    props.store.updateSettings((settings) => ({ ...settings, slack: null }))
    return { slack: "logged out" }
  }
  const prepared: { contents: string } = { contents: "" }
  try {
    prepared.contents = await props.clipboard.read()
  } catch (error) {
    throw new CliError(
      "NEEDS_HUMAN",
      error instanceof ClipboardReadError
        ? error.message
        : "Clipboard is unavailable; copy the Slack token in your desktop clipboard.",
      { code: error instanceof ClipboardReadError ? error.code : "UNAVAILABLE" },
    )
  }
  props.signal?.throwIfAborted()
  if (Buffer.byteLength(prepared.contents, "utf8") > 8192)
    throw new CliError(
      "NEEDS_HUMAN",
      "Copy only one Slack token; clipboard data must be at most 8192 bytes",
      { code: "CLIPBOARD_TOO_LARGE" },
    )
  const token = (
    props.kind === "bot"
      ? slackCredentialsSchema.shape.botToken
      : slackCredentialsSchema.shape.appToken
  ).safeParse(prepared.contents.trim())
  prepared.contents = ""
  if (!token.success)
    throw new CliError(
      "NEEDS_HUMAN",
      `Copy only the Slack ${props.kind} token (${props.kind === "bot" ? "xox..." : "xapp-..."}) to the clipboard, then run leuco slack login ${props.kind}. The value is never printed.`,
      { code: "CLIPBOARD_INVALID_TOKEN" },
    )
  const draft = await readSlackCredentialDraft(props.credentials, previous?.credential ?? null)
  const saved = { ...draft, [props.kind === "bot" ? "botToken" : "appToken"]: token.data }
  const missing: string[] = []
  if (!saved.botToken) missing.push("bot")
  if (!saved.appToken) missing.push("app")
  props.signal?.throwIfAborted()
  const credential = randomUUID()
  await props.credentials.set(credential, JSON.stringify(saved))
  try {
    props.signal?.throwIfAborted()
    props.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential, ackMode: settings.slack?.ackMode ?? "mention" },
    }))
  } catch (error) {
    try {
      await props.credentials.delete(credential)
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Settings could not be saved and the new OS credential could not be removed; inspect both causes",
        { cause: error },
      )
    }
    throw error
  }
  if (previous !== null) await props.credentials.delete(previous.credential)
  return {
    slack: "saved in OS credential store",
    saved: props.kind,
    complete: missing.length === 0,
    missing,
    restartRequired: true,
  }
}
