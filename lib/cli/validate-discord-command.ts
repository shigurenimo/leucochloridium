import { CliError } from "@/cli/cli-error"
import type { CliArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

export function validateDiscordCommand(parsed: CliArguments): void {
  if (parsed.flags.help === true)
    throw new CliError(
      "USAGE",
      "Discord execution does not accept --help; run leuco discord --help through the CLI",
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
  if (parsed.words[0] !== "discord" || parsed.words[1] !== "call")
    throw new CliError("USAGE", "Unsupported Discord operation", {
      phase: "validation",
      executionStarted: false,
    })
}
