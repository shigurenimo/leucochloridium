import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { withDaemonReservation } from "@/daemon/with-daemon-reservation"
import { errorDetails } from "@/error-details"
import { withFileLock } from "@/fs/with-file-lock"
import { inspectRuntimeHealth } from "@/runtime/inspect-runtime-health"
import { readRegularBytes } from "@/fs/read-regular-bytes"
import { writeStateBackup } from "@/maintenance/write-state-backup"
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { readDaemonLease, isProcessAlive, releaseDaemonLease } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { CliError } from "@/cli/cli-error"
import { inspectDiagnosticHistory } from "@/cli/inspect-diagnostic-history"

export async function repairRuntime(
  home: string,
  options: { resetState: boolean; signal?: AbortSignal },
) {
  options.signal?.throwIfAborted()
  const store = new NodeLeucoStore(home)
  const actions: string[] = []
  const stateReset = { completed: false }
  try {
    store.loadSettings()
  } catch (error) {
    throw new CliError(
      "STATE_CONFLICT",
      "Settings are invalid. Preserve settings.json and repair the documented fields; credentials/configuration will not be overwritten automatically.",
      { causes: errorDetails(error) },
    )
  }
  const lease = readDaemonLease(home)
  const alive = lease !== null && isProcessAlive(lease.pid)
  if (!alive)
    assertRecordedDaemonsStopped(new NodeMaintenanceStore(home).readOperation(), isProcessAlive)
  try {
    store.loadState()
  } catch (error) {
    if (!options.resetState || alive)
      throw new CliError(
        "STATE_CONFLICT",
        "Runtime state is invalid. Stop Leuco, then explicitly use repair --reset-state to archive it and rebuild empty mappings. Native Codex history is retained.",
        { causes: errorDetails(error) },
      )
    await withDaemonReservation(home, () =>
      withFileLock({ lockPath: join(home, "state.lock") }, () => {
        const valid = (() => {
          try {
            store.loadState()
            return true
          } catch {
            return false
          }
        })()
        if (valid)
          throw new CliError(
            "STATE_CONFLICT",
            "Runtime state became valid before reset; existing mappings were preserved. Run leuco session list before retrying.",
            { phase: "state-reset" },
          )
        const backup = join(home, `state.invalid.${Date.now()}.${randomUUID()}.json`)
        writeStateBackup(backup, readRegularBytes(join(home, "state.json")))
        atomicWriteJson({
          path: join(home, "state.json"),
          data: { threads: {}, scheduleLastFiredAt: {} },
          mode: 0o600,
        })
        actions.push(`Archived invalid runtime state to ${backup}; created empty mappings`)
      }),
    )
    stateReset.completed = true
  }
  store.ensureHome()
  for (const name of [
    "settings.json",
    "state.json",
    "events.db",
    "events.db-wal",
    "events.db-shm",
    "daemon.log",
    "launch.json",
    "maintenance.json",
    "daemon.json",
    "control.sock",
  ]) {
    const path = join(home, name)
    if (
      existsSync(path) &&
      !lstatSync(path).isSymbolicLink() &&
      (lstatSync(path).mode & 0o777) !== 0o600
    ) {
      chmodSync(path, 0o600)
      actions.push(`Restricted ${name} to owner-only access`)
    }
  }
  if (lease !== null && !alive && !stateReset.completed) {
    if (!releaseDaemonLease(home, lease))
      throw new CliError(
        "STATE_CONFLICT",
        "Daemon ownership changed during repair; current metadata was preserved. Inspect status before retrying.",
        { phase: "identity", previousPid: lease.pid, actions },
      )
    actions.push("Removed confirmed stale daemon lease and control socket")
  }
  withFileLock({ lockPath: join(home, "lifecycle.lock") }, () => {
    if (readDaemonLease(home) === null && existsSync(join(home, "control.sock"))) {
      rmSync(join(home, "control.sock"))
      actions.push("Removed orphan control socket without a daemon lease")
    }
  })
  if (alive) {
    const status = await requestDaemon({
      home,
      path: "/status",
      expectedLease: lease ?? undefined,
      timeoutMs: 2000,
      signal: options.signal,
    })
    const health = inspectRuntimeHealth(status)
    const history = inspectDiagnosticHistory(home, status)
    if (!history.eventLogValid && history.eventLogPresent === false)
      return {
        repaired: false,
        actions,
        restart: null,
        note: "Live SQLite history is missing; run leuco doctor to inspect its causes before recovery. No restart was requested.",
        issues: [...health.issues, ...history.errors],
      }
    if (!health.restartRecommended)
      return {
        repaired: health.healthy && history.eventLogValid,
        actions,
        restart: null,
        note: !history.eventLogValid
          ? "Event history cannot be verified; inspect leuco doctor failure causes. No transport restart is required."
          : health.healthy
            ? "Daemon is responsive and healthy; no work was replayed"
            : "No automatic restart is appropriate; inspect health issues for the next recovery step",
        issues: [...health.issues, ...history.errors],
      }
    return {
      repaired: true,
      actions,
      restart: await requestDaemon({
        home,
        path: "/restart",
        expectedLease: lease ?? undefined,
        body: {},
        timeoutMs: 5000,
        signal: options.signal,
      }),
      ...(history.eventLogValid ? {} : { issues: history.errors }),
      note: "Recovery accepted; inspect status and doctor. Existing work is not replayed.",
    }
  }
  return {
    repaired: true,
    actions,
    restart: null,
    note: "Local metadata repaired. Daemon was not started; use start when intended.",
  }
}
