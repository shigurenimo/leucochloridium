import { CliError } from "@/cli/cli-error"
import type { CliArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

export function validateSlackCommand(parsed: CliArguments): void {
  if (parsed.flags.help === true)
    throw new CliError(
      "USAGE",
      "Slack execution does not accept --help; run leuco slack --help through the CLI",
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
  if (
    parsed.words[0] !== "slack" ||
    !["call", "upload-file", "download-file"].includes(parsed.words[1] ?? "")
  )
    throw new CliError("USAGE", "Unsupported Slack operation", {
      phase: "validation",
      executionStarted: false,
    })
}
