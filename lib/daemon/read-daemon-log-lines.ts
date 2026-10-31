import { lstatSync } from "node:fs"
import { join } from "node:path"
import { readRegularText } from "@/fs/read-regular-text"
import { redactPublicText } from "@/secrets/redact-public-text"
import { tailLogLines } from "@/daemon/tail-log-lines"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"

/** Log generations are newest-first; read older ones only to fill the requested tail. */
export function readDaemonLogLines(home: string, limit: number): string[] {
  const lines: string[] = []
  for (const suffix of ["", ".1", ".2", ".3"]) {
    if (lines.length >= limit) break
    const generation = `daemon.log${suffix}`
    const path = join(home, generation)
    try {
      if (lstatSync(path, { throwIfNoEntry: false }) === undefined) continue
      const text = redactPublicText(
        readRegularText(path, 16 * 1024 * 1024, { followSymlinks: false }),
      )
      lines.unshift(...tailLogLines(text, limit - lines.length))
    } catch (error) {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Cannot read complete daemon text logs (${generation}): ${errorMessage(error)}. Read partial history from error.details.savedLines.`,
        {
          phase: "log-read",
          generation,
          historyComplete: false,
          savedLines: [...lines],
          causes: errorDetails(error),
        },
      )
      failure.cause = error
      throw failure
    }
  }
  return lines
}
