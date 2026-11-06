import { CHAT_PROVIDERS } from "@/cli/chat-providers"
import type { ChatProvider } from "@/cli/chat-providers"
import { CliError } from "@/cli/cli-error"
import type { CliArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

export function validateDaemonCommand(parsed: CliArguments, provider: ChatProvider): void {
  const definition = CHAT_PROVIDERS[provider]
  if (parsed.flags.help === true)
    throw new CliError(
      "USAGE",
      `${definition.name} execution does not accept --help; run leuco ${provider} --help through the CLI`,
      {
        phase: "validation",
        executionStarted: false,
      },
    )
  try {
    validateCommand(parsed)
  } catch (cause) {
    if (!(cause instanceof CliError) || cause.code !== "USAGE") throw cause
    const failure = new CliError("USAGE", cause.message, {
      phase: "validation",
      executionStarted: false,
      validation: cause.details,
    })
    failure.cause = cause
    throw failure
  }
  if (parsed.words[0] !== provider || !definition.actions.includes(parsed.words[1] ?? ""))
    throw new CliError("USAGE", `Unsupported ${definition.name} operation`, {
      phase: "validation",
      executionStarted: false,
    })
}
