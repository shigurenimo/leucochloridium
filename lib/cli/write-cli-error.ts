import { isVersionRequest } from "@/cli/is-version-request"
import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"
import { errorDetails } from "@/error-details"
import { serializeCliValue } from "@/cli/serialize-cli-value"
import { CliError, ERROR_CODES, cliErrorCodeSchema } from "@/cli/cli-error"
import { snapshotCliErrorDetails } from "@/cli/snapshot-cli-error-details"
import { jsonMode } from "@/cli/json-mode"
import { parseArguments } from "@/cli/parse-arguments"
import { resolveCommand } from "@/cli/resolve-command"
import { errorMessage } from "@/error-message"
import { writeCliText } from "@/cli/write-cli-text"
import type { DiagnosticOutput } from "@/diagnostic-output"

export async function writeCliError(
  error: unknown,
  args: string[],
  request: { requestId: string; output?: DiagnosticOutput },
): Promise<void> {
  const context: { command: string | null; mutating: boolean } = { command: null, mutating: false }
  try {
    if (isVersionRequest(args)) context.command = "version"
    else {
      const parsed = parseArguments(args)
      const command = resolveCommand(parsed.words).definition
      context.command = command.name
      context.mutating = parsed.flags.help !== true && command.effect !== "read"
    }
  } catch {
    /* Input validation can fail before a command is identified. */
  }
  const cliError = (() => {
    try {
      if (!(error instanceof CliError)) return null
      const parsed = cliErrorCodeSchema.safeParse(error.code)
      return parsed.success ? { error, code: parsed.data } : null
    } catch {
      return null
    }
  })()
  const failure =
    cliError?.error ??
    new CliError("OPERATION_FAILED", errorMessage(error), { causes: errorDetails(error) })
  const code = cliError?.code ?? "OPERATION_FAILED"
  const diagnostic = snapshotCliErrorDetails(failure)
  const knownBeforeExecution = [
    "USAGE",
    "NOT_RUNNING",
    "STATE_CONFLICT",
    "NEEDS_HUMAN",
    "CHECK_FAILED",
  ].includes(code)
  // Repair may change local permissions before checking live recovery/ownership.
  const repairMayHaveChangedMetadata =
    context.command === "repair" && ["STATE_CONFLICT", "NOT_RUNNING"].includes(code)
  const mutationMayHaveOccurred =
    context.mutating &&
    (!knownBeforeExecution || repairMayHaveChangedMetadata || diagnostic.mutationPossible)
  const message = truncateDiagnosticText(
    redactPublicText(errorMessage(failure)),
    MAX_DIAGNOSTIC_MESSAGE_CHARACTERS,
  )
  process.exitCode = ERROR_CODES[code].exitCode
  await writeCliText(
    `${serializeCliValue({ schemaVersion: 1, ok: false, command: context.command, requestId: request.requestId, error: { code: code, message, hint: ERROR_CODES[code].recovery, mutationMayHaveOccurred, details: diagnostic.details } }, jsonMode(args))}\n`,
    { destination: "stderr", output: request.output },
  )
}
