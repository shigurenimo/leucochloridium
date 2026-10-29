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
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"

export function scheduleRestart(
  home: string,
  overrides: Partial<LaunchConfiguration> = {},
  context: { requestId?: string; automatic?: boolean } = {},
) {
  new NodeLeucoStore(home).ensureHome()
  return withFileLock({ lockPath: join(home, "maintenance-schedule.lock") }, () => {
    const store = new NodeMaintenanceStore(home)
    const previous = store.readOperation()
    if (
      previous?.workerPid &&
      isProcessAlive(previous.workerPid) &&
      ["accepted", "stopping", "starting"].includes(previous.status)
    )
      return previous
    const launch = {
      ...(store.readLaunch() ?? {
        workingDirectory: process.cwd(),
        codexHome: process.env.CODEX_HOME ?? null,
      }),
      ...overrides,
    }
    const lease = readDaemonLease(home)
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
    const child = spawn(
      process.execPath,
      [resolve(import.meta.dir, "restart-worker.ts"), operation.id],
      {
        detached: true,
        cwd: process.cwd(),
        env: { ...process.env, LEUCO_HOME: home },
        stdio: "ignore",
      },
    )
    const accepted: MaintenanceOperation = {
      ...operation,
      status: "accepted",
      workerPid: child.pid ?? null,
    }
    recordMaintenanceOperation(home, accepted, operation.id)
    child.on("error", () =>
      recordMaintenanceOperation(
        home,
        {
          ...accepted,
          status: "failed",
          updatedAt: Date.now(),
          error: "Unable to spawn detached restart worker",
        },
        operation.id,
      ),
    )
    child.unref()
    return accepted
  })
}
