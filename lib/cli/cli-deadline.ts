import type { CliInvocation } from "@/cli/parse-cli-invocation"
import { CliError, ERROR_CODES } from "@/cli/cli-error"
import { writeCliError } from "@/cli/write-cli-error"
import { DEFAULT_CLI_TIMEOUT_MS } from "@/cli/command-catalog"

export const CLI_FORCED_EXIT_GRACE_MS = 5000

export class CliDeadline {
  readonly controller = new AbortController()
  private timer: ReturnType<typeof setTimeout> | null = null
  private forcedExit: ReturnType<typeof setTimeout> | null = null
  expired = false
  errorOutput: Promise<void> | null = null

  constructor(invocation: CliInvocation, args: string[], requestId: string) {
    if (invocation.mode !== "command") return
    const parsed = invocation.parsed
    if (parsed.flags.foreground && parsed.flags["timeout-ms"] === undefined) return
    const timeout = Number(parsed.flags["timeout-ms"] ?? DEFAULT_CLI_TIMEOUT_MS)
    this.timer = setTimeout(() => {
      this.expired = true
      this.forcedExit = setTimeout(
        () => process.exit(ERROR_CODES.STATE_UNCERTAIN.exitCode),
        CLI_FORCED_EXIT_GRACE_MS,
      )
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
