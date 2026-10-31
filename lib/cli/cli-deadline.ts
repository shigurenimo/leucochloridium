import { isVersionRequest } from "@/cli/is-version-request"
import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"
import { CliError, ERROR_CODES } from "@/cli/cli-error"
import { writeCliError } from "@/cli/write-cli-error"
import { DEFAULT_CLI_TIMEOUT_MS } from "@/cli/command-catalog"

export class CliDeadline {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private forcedExit: ReturnType<typeof setTimeout> | null = null
  expired = false
  errorOutput: Promise<void> | null = null

  constructor(args: string[], requestId: string) {
    if (isVersionRequest(args)) return
    const parsed = parseArguments(args)
    if (parsed.flags.help || args.length === 0) return
    validateCommand(parsed)
    if (parsed.flags.foreground && parsed.flags["timeout-ms"] === undefined) return
    const timeout = Number(parsed.flags["timeout-ms"] ?? DEFAULT_CLI_TIMEOUT_MS)
    this.timer = setTimeout(() => {
      this.expired = true
      this.forcedExit = setTimeout(() => process.exit(ERROR_CODES.STATE_UNCERTAIN.exitCode), 5000)
      this.controller.abort()
      this.errorOutput = writeCliError(
        new CliError(
          "STATE_UNCERTAIN",
          `CLI deadline exceeded (${timeout} ms). The operation may still be running; inspect status, events and the external destination before retrying.`,
        ),
        args,
        { requestId },
      ).catch(() => {
        process.exitCode = ERROR_CODES.STATE_UNCERTAIN.exitCode
      })
    }, timeout)
  }
  finish(): void {
    this.stopObservation()
    if (this.forcedExit !== null) clearTimeout(this.forcedExit)
  }

  stopObservation(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }
}
