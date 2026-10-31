import type { Clipboard } from "@/clipboard/clipboard"
import { ClipboardReadError } from "@/clipboard/clipboard-read-error"
import { CliError } from "@/cli/cli-error"
import { discordCredentialsSchema } from "@/secrets/discord-credentials"

/** The raw clipboard stays inside this read/validate boundary. */
export async function readDiscordTokenFromClipboard(
  clipboard: Clipboard,
  signal?: AbortSignal,
): Promise<string> {
  const prepared: { contents: string } = { contents: "" }
  try {
    prepared.contents = await clipboard.read()
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
        "Clipboard is unavailable; copy the Discord token in your desktop clipboard.",
      { code: diagnostic?.code ?? "UNAVAILABLE" },
    )
  }
  signal?.throwIfAborted()
  if (Buffer.byteLength(prepared.contents, "utf8") > 8192)
    throw new CliError(
      "NEEDS_HUMAN",
      "Copy only one Discord token; clipboard data must be at most 8192 bytes",
      { code: "CLIPBOARD_TOO_LARGE" },
    )
  const token = discordCredentialsSchema.shape.botToken.safeParse(prepared.contents.trim())
  prepared.contents = ""
  if (!token.success)
    throw new CliError(
      "NEEDS_HUMAN",
      "Copy only the Discord bot token to the clipboard, then run leuco discord login. The value is never printed.",
      { code: "CLIPBOARD_INVALID_TOKEN" },
    )
  return token.data
}
