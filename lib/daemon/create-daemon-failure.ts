import { CliError, cliErrorCodeSchema } from "@/cli/cli-error"
import type { DaemonFailure } from "@/daemon/daemon-failure-schema"
import { daemonFailureSchema } from "@/daemon/daemon-failure-schema"
import { errorDetails } from "@/error-details"
import { redactJsonSecrets } from "@/secrets/redact-json-secrets"

/** Keep classified failures bounded and JSON-safe without trusting arbitrary error metadata. */
export function createDaemonFailure(
  error: unknown,
  secrets: ReadonlyArray<string>,
): DaemonFailure | null {
  const code = (() => {
    try {
      if (!(error instanceof CliError)) return null
      const parsed = cliErrorCodeSchema.safeParse(error.code)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  })()
  if (code === null) return null
  try {
    const serialized = JSON.stringify(
      redactJsonSecrets(
        {
          schemaVersion: 1,
          code,
          details: error instanceof CliError ? error.details : null,
          causes: errorDetails(error, secrets),
        },
        secrets,
      ),
    )
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > 64 * 1024)
      throw new Error("Daemon failure details exceed 64 KiB")
    return daemonFailureSchema.parse(JSON.parse(serialized))
  } catch (serialization) {
    return {
      schemaVersion: 1,
      code,
      details: { phase: "daemon-error-details", originalDetailsAvailable: false },
      causes: errorDetails(
        new AggregateError([error, serialization], "Daemon error details could not be serialized", {
          cause: error,
        }),
        secrets,
      ),
    }
  }
}
