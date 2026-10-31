import { hasPossibleMutation } from "@/cli/has-possible-mutation"
import { z } from "zod"
import { createDaemonFailure } from "@/daemon/create-daemon-failure"
import type { LeucoEventLog } from "@/events/leuco-event-log"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"

export function reportDaemonRequestFailure(
  log: LeucoEventLog,
  error: unknown,
  requestId: string,
): string {
  const failure = createDaemonFailure(error, [])
  const rejected =
    failure?.code === "USAGE" &&
    !hasPossibleMutation(failure.details) &&
    z
      .object({
        phase: z.enum(["validation", "control-body"]),
        executionStarted: z.literal(false),
      })
      .safeParse(failure.details).success
  const message = errorMessage(error)
  log.append({
    ts: Date.now(),
    type: "log",
    level: rejected ? "warn" : "error",
    line: `Daemon request failed: ${message}`,
    requestId,
    causes: errorDetails(error, [], (text) => log.redactText(text)),
  })
  return log.redactText(message)
}
