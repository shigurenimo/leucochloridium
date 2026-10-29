import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"
import { CliError, ERROR_CODES } from "@/cli/cli-error"
import { writeCliError } from "@/cli/write-cli-error"

export class CliDeadline {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private forcedExit: ReturnType<typeof setTimeout> | null = null
  expired = false

  constructor(args: string[], requestId: string) {
    if (
      args.some((entry) => entry === "--version" || entry === "-v") &&
      args.every((entry) => ["--version", "-v", "--json", "--yaml"].includes(entry))
    )
      return
    const parsed = parseArguments(args)
    if (parsed.flags.help || args.length === 0) return
    validateCommand(parsed)
    if (parsed.flags.foreground && parsed.flags["timeout-ms"] === undefined) return
    const timeout = Number(parsed.flags["timeout-ms"] ?? 30000)
    this.timer = setTimeout(() => {
      this.expired = true
      this.controller.abort()
      writeCliError(
        new CliError(
          "STATE_UNCERTAIN",
          `CLI deadline exceeded (${timeout} ms). The operation may still be running; inspect status, events and the external destination before retrying.`,
        ),
        args,
        requestId,
      )
      this.forcedExit = setTimeout(() => process.exit(ERROR_CODES.STATE_UNCERTAIN.exitCode), 5000)
    }, timeout)
  }
  finish(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.forcedExit !== null) clearTimeout(this.forcedExit)
  }
}
