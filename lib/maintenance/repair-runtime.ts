import { errorDetails } from "@/error-details"
import { withFileLock } from "@/fs/with-file-lock"
import { inspectRuntimeHealth } from "@/runtime/inspect-runtime-health"
import { readRegularText } from "@/fs/read-regular-text"
import { chmodSync, existsSync, lstatSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import {
  readDaemonLease,
  isProcessAlive,
  releaseDaemonLease,
  acquireDaemonLease,
} from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { CliError } from "@/cli/cli-error"

export async function repairRuntime(
  home: string,
  options: { resetState: boolean; signal?: AbortSignal },
) {
  const store = new NodeLeucoStore(home)
  const actions: string[] = []
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
  try {
    store.loadState()
  } catch (error) {
    if (!options.resetState || alive)
      throw new CliError(
        "STATE_CONFLICT",
        "Runtime state is invalid. Stop Leuco, then explicitly use repair --reset-state to archive it and rebuild empty mappings. Native Codex history is retained.",
        { causes: errorDetails(error) },
      )
    const reservation = acquireDaemonLease(home)
    try {
      const backup = join(home, `state.invalid.${Date.now()}.${randomUUID()}.json`)
      writeFileSync(backup, readRegularText(join(home, "state.json")), { flag: "wx", mode: 0o600 })
      atomicWriteJson({
        path: join(home, "state.json"),
        data: { threads: {}, scheduleLastFiredAt: {} },
        mode: 0o600,
      })
      actions.push(`Archived invalid runtime state to ${backup}; created empty mappings`)
    } finally {
      releaseDaemonLease(home, reservation)
    }
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
  if (lease !== null && !alive) {
    releaseDaemonLease(home, lease)
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
    if (!health.restartRecommended)
      return {
        repaired: health.healthy,
        actions,
        restart: null,
        note: health.healthy
          ? "Daemon is responsive and healthy; no work was replayed"
          : "No automatic restart is appropriate; inspect health issues and observe reconnecting/startup progress",
        issues: health.issues,
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
      note: "Recovery accepted; inspect status. Existing work is not replayed.",
    }
  }
  return {
    repaired: true,
    actions,
    restart: null,
    note: "Local metadata repaired. Daemon was not started; use start when intended.",
  }
}
