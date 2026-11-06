import type { Clipboard } from "@/clipboard/clipboard"
import { ClipboardReadError } from "@/clipboard/clipboard-read-error"
import { CHAT_PROVIDERS } from "@/cli/chat-providers"
import type { ChatProvider, ChatToken } from "@/cli/chat-providers"
import { CliError } from "@/cli/cli-error"

type Props = {
  clipboard: Clipboard
  provider: ChatProvider
  token: ChatToken
  signal?: AbortSignal
}

/** The raw clipboard stays inside this read/validate boundary. */
export async function readTokenFromClipboard(props: Props): Promise<string> {
  const name = CHAT_PROVIDERS[props.provider].name
  const prepared: { contents: string } = { contents: "" }
  try {
    prepared.contents = await props.clipboard.read()
  } catch (error) {
    const diagnostic = (() => {
      try {
        if (error instanceof ClipboardReadError) {
          const message = error.message
          const code = error.code
          if (
            typeof message === "string" &&
            ["UNAVAILABLE", "FAILED", "TIMEOUT", "TOO_LARGE"].includes(code)
          )
            return { message, code }
        }
      } catch {
        // Clipboard failure metadata must not replace the safe human guidance.
      }
      return null
    })()
    throw new CliError(
      "NEEDS_HUMAN",
      diagnostic?.message ??
        `Clipboard is unavailable; copy the ${name} token in your desktop clipboard.`,
      { code: diagnostic?.code ?? "UNAVAILABLE" },
    )
  }
  props.signal?.throwIfAborted()
  if (Buffer.byteLength(prepared.contents, "utf8") > 8192)
    throw new CliError(
      "NEEDS_HUMAN",
      `Copy only one ${name} token; clipboard data must be at most 8192 bytes`,
      { code: "CLIPBOARD_TOO_LARGE" },
    )
  const value = props.token.schema.safeParse(prepared.contents.trim())
  prepared.contents = ""
  if (!value.success)
    throw new CliError(
      "NEEDS_HUMAN",
      `Copy only the ${name} ${props.token.kind} token${props.token.format === null ? "" : ` (${props.token.format})`} to the clipboard, then run ${props.token.login}. The value is never printed.`,
      { code: "CLIPBOARD_INVALID_TOKEN" },
    )
  return value.data
}
