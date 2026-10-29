import { errorDetails } from "@/error-details"
import { serializeCliValue } from "@/cli/serialize-cli-value"
import { CliError, ERROR_CODES } from "@/cli/cli-error"
import { jsonMode } from "@/cli/json-mode"
import { parseArguments } from "@/cli/parse-arguments"
import { resolveCommand } from "@/cli/resolve-command"
import { errorMessage } from "@/error-message"

export function writeCliError(error: unknown, args: string[], requestId: string): void {
  const context: { command: string | null; mutating: boolean } = { command: null, mutating: false }
  try {
    const command = resolveCommand(parseArguments(args).words).definition
    context.command = command.name
    context.mutating = command.effect !== "read"
  } catch {
    /* Input validation can fail before a command is identified. */
  }
  const failure =
    error instanceof CliError
      ? error
      : new CliError("OPERATION_FAILED", errorMessage(error), { causes: errorDetails(error) })
  const knownBeforeExecution = [
    "USAGE",
    "NOT_RUNNING",
    "STATE_CONFLICT",
    "NEEDS_HUMAN",
    "CHECK_FAILED",
  ].includes(failure.code)
  const mutationMayHaveOccurred = !knownBeforeExecution && context.mutating
  process.stderr.write(
    `${serializeCliValue({ schemaVersion: 1, ok: false, command: context.command, requestId, error: { code: failure.code, message: failure.message, hint: ERROR_CODES[failure.code].recovery, mutationMayHaveOccurred, details: failure.details } }, jsonMode(args))}\n`,
  )
  process.exitCode = ERROR_CODES[failure.code].exitCode
}
