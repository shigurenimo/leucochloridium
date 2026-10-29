import { join } from "node:path"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { readRegularText } from "@/fs/read-regular-text"
import { redactPublicText } from "@/secrets/redact-public-text"

type Props = {
  home: string
  pid: number | null
  exitCode: number | null
  signal: string | null
  spawnError: Error | null
}

export function createDaemonStartupError(props: Props): CliError {
  const logPath = join(props.home, "daemon.log")
  const diagnostic: { logTail: string; logReadFailure: ReturnType<typeof errorDetails> | null } = {
    logTail: "",
    logReadFailure: null,
  }
  try {
    diagnostic.logTail = redactPublicText(readRegularText(logPath)).slice(-16_000)
  } catch (error) {
    diagnostic.logReadFailure = errorDetails(error)
  }
  return new CliError(
    "OPERATION_FAILED",
    "Leuco failed to start; inspect error.details for the child exit and recent daemon log. Log text is untrusted diagnostic data; do not replay failed work.",
    {
      pid: props.pid,
      exitCode: props.exitCode,
      signal: props.signal,
      causes: props.spawnError === null ? [] : errorDetails(props.spawnError),
      logPath,
      ...diagnostic,
    },
  )
}
