import type { DaemonLease } from "@/daemon/daemon-lease"
import { runningDaemonStatusSchema } from "@/daemon/daemon-status-schema"
import { CliError } from "@/cli/cli-error"
import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"

export function verifyDaemonStatus(
  value: unknown,
  expected: DaemonLease,
  current: DaemonLease | null,
) {
  if (current === null || current.pid !== expected.pid || current.token !== expected.token)
    throw new CliError(
      "STATE_CONFLICT",
      "Daemon ownership changed while reading status; do not act on stale state",
      {
        phase: "identity",
        expectedPid: expected.pid,
        currentPid: current?.pid ?? null,
      },
    )
  const parsed = runningDaemonStatusSchema.safeParse(value)
  if (!parsed.success) {
    const failure = new CliError(
      "STATE_UNCERTAIN",
      "Live daemon status is invalid or incomplete; inspect ownership before acting",
      {
        phase: "status",
        ...getBoundedValidationIssues(parsed.error),
      },
    )
    failure.cause = parsed.error
    throw failure
  }
  if (parsed.data.pid !== expected.pid)
    throw new CliError(
      "STATE_UNCERTAIN",
      `Daemon status PID ${parsed.data.pid} does not match authenticated lease PID ${expected.pid}; inspect ownership before acting`,
      {
        phase: "identity",
        expectedPid: expected.pid,
        reportedPid: parsed.data.pid,
      },
    )
  return parsed.data
}
