import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { recordRestartSpawnFailure } from "@/maintenance/record-restart-spawn-failure"
import { errorDetails } from "@/error-details"
import { getRecoveryWindow } from "@/maintenance/get-recovery-window"
import { CliError } from "@/cli/cli-error"
import { getDaemonLeaseId } from "@/daemon/get-daemon-lease-id"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { resolve, join } from "node:path"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import type { LaunchConfiguration, MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { withFileLock } from "@/fs/with-file-lock"
import type { DaemonLease } from "@/daemon/daemon-lease"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"

export function scheduleRestart(
  home: string,
  overrides: Partial<LaunchConfiguration> = {},
  context: { requestId?: string; automatic?: boolean; expectedLease?: DaemonLease | null } = {},
) {
  new NodeLeucoStore(home).ensureHome()
  return withFileLock({ lockPath: join(home, "maintenance-schedule.lock") }, () => {
    const lease = readDaemonLease(home)
    const expected = context.expectedLease
    if (
      expected !== undefined &&
      (expected === null
        ? lease !== null
        : lease === null || expected.pid !== lease.pid || expected.token !== lease.token)
    )
      throw new CliError(
        "STATE_CONFLICT",
        "Daemon ownership changed before restart scheduling; no recovery request was created. Inspect status before retrying.",
        {
          phase: "identity",
          executionStarted: false,
          expectedPid: expected?.pid ?? null,
          actualPid: lease?.pid ?? null,
          expectedLeaseId: expected === null ? null : getDaemonLeaseId(expected),
          actualLeaseId: lease === null ? null : getDaemonLeaseId(lease),
        },
      )
    const store = new NodeMaintenanceStore(home)
    const previous = store.readOperation()
    if (
      previous?.workerPid &&
      isProcessAlive(previous.workerPid) &&
      ["accepted", "stopping", "starting"].includes(previous.status)
    )
      return previous
    if (lease === null || !isProcessAlive(lease.pid))
      assertRecordedDaemonsStopped(previous, isProcessAlive)
    const launch = {
      ...(store.readLaunch() ?? {
        workingDirectory: process.cwd(),
        codexHome: process.env.CODEX_HOME ?? null,
      }),
      ...overrides,
    }
    const operation: MaintenanceOperation = {
      id: context.requestId ?? randomUUID(),
      status: "accepted",
      requestedAt: Date.now(),
      updatedAt: Date.now(),
      workerPid: null,
      oldPid: lease?.pid ?? null,
      oldLeaseId: lease === null ? null : getDaemonLeaseId(lease),
      recovery: context.automatic
        ? getRecoveryWindow(previous?.recovery ?? null, Date.now())
        : null,
      newPid: null,
      error: null,
      launch,
    }
    if (operation.recovery && operation.recovery.attempt > 3) {
      const message =
        "Automatic restart suspended after 3 recovery attempts within 60 seconds. Inspect events/logs and fix the cause before an explicit restart."
      recordMaintenanceOperation(home, { ...operation, status: "failed", error: message })
      throw new CliError("STATE_CONFLICT", message)
    }
    recordMaintenanceOperation(home, { ...operation, status: "accepted" })
    const child = (() => {
      try {
        return spawn(
          process.execPath,
          [resolve(import.meta.dir, "restart-worker.ts"), operation.id],
          {
            detached: true,
            cwd: process.cwd(),
            env: { ...process.env, LEUCO_HOME: home },
            stdio: "ignore",
          },
        )
      } catch (error) {
        recordRestartSpawnFailure(home, operation, error)
        throw error
      }
    })()
    const accepted: MaintenanceOperation = {
      ...operation,
      status: "accepted",
      workerPid: child.pid ?? null,
    }
    child.on("error", (error) => recordRestartSpawnFailure(home, accepted, error))
    child.unref()
    try {
      if (!recordMaintenanceOperation(home, accepted, operation.id))
        throw new Error("Restart operation ownership changed before worker publication")
    } catch (cause) {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Restart worker spawn was requested (PID ${accepted.workerPid ?? "unknown"}), but its publication was not verified. Inspect maintenance status before another restart.`,
        {
          phase: "worker-publication",
          operationId: operation.id,
          workerPid: accepted.workerPid,
          causes: errorDetails(cause),
        },
      )
      failure.cause = cause
      throw failure
    }
    return accepted
  })
}
