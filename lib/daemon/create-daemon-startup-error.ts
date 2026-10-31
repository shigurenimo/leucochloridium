import { DEFAULT_LOCAL_DATA_MAX_BYTES } from "@/fs/local-data-limits"
import { join } from "node:path"
import { sliceTextSuffix } from "@/slice-text-suffix"
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
  const diagnostic: {
    logTail: string
    logTailTruncated: boolean | null
    logReadFailure: ReturnType<typeof errorDetails> | null
  } = {
    logTail: "",
    logTailTruncated: null,
    logReadFailure: null,
  }
  try {
    const text = redactPublicText(
      readRegularText(logPath, DEFAULT_LOCAL_DATA_MAX_BYTES, { followSymlinks: false }),
    )
    diagnostic.logTail = sliceTextSuffix(text, 16_000)
    diagnostic.logTailTruncated = diagnostic.logTail.length < text.length
  } catch (error) {
    diagnostic.logReadFailure = errorDetails(error)
  }
  const failure = new CliError(
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
  failure.cause = new Error(
    `Daemon startup ended before readiness: pid=${props.pid ?? "unknown"}, exitCode=${props.exitCode ?? "unknown"}, signal=${props.signal ?? "none"}`,
    props.spawnError === null ? undefined : { cause: props.spawnError },
  )
  return failure
}
