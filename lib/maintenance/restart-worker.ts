import { getDaemonLeaseId } from "@/daemon/get-daemon-lease-id"
import { errorDetails } from "@/error-details"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { openDaemonLog } from "@/daemon/open-daemon-log"
import { CliError } from "@/cli/cli-error"
import { resolve } from "node:path"
import { spawn } from "node:child_process"
import { closeSync } from "node:fs"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"

const home = process.env.LEUCO_HOME!
const store = new NodeMaintenanceStore(home)
const operation = store.readOperation()
if (operation === null || operation.id !== process.argv[2]) process.exit(1)
const current: { value: MaintenanceOperation } = { value: operation }
const update = (
  status: MaintenanceOperation["status"],
  error: string | null = null,
  newPid: number | null = current.value.newPid,
): void => {
  current.value = { ...current.value, status, error, newPid, updatedAt: Date.now() }
  if (!recordMaintenanceOperation(home, current.value, operation.id)) {
    process.stderr.write(
      "leuco: restart operation was superseded; the old worker will not change the new journal\n",
    )
    process.exit(0)
  }
}
try {
  const publicationDeadline = Date.now() + 5000
  while (Date.now() < publicationDeadline) {
    const published = store.readOperation()
    if (published?.id !== operation.id) process.exit(0)
    if (published.workerPid === process.pid) {
      current.value = published
      break
    }
    await Bun.sleep(50)
  }
  if (current.value.workerPid !== process.pid)
    throw new Error("Restart worker ownership was not published; no daemon was stopped or started")
  await Bun.sleep(500)
  const previous = readDaemonLease(home)
  if (previous && isProcessAlive(previous.pid)) {
    if (previous.pid !== operation.oldPid || getDaemonLeaseId(previous) !== operation.oldLeaseId)
      throw new Error(
        "Daemon identity changed after restart was requested; refusing to stop another process",
      )
    update("stopping")
    await requestDaemon({ home, path: "/stop", body: {}, timeoutMs: 5000, expectedLease: previous })
    const stopDeadline = Date.now() + 20000
    while (Date.now() < stopDeadline && isProcessAlive(previous.pid)) await Bun.sleep(100)
    if (isProcessAlive(previous.pid)) {
      update("uncertain", "Old daemon is still stopping. No replacement was started.")
      process.exit(0)
    }
  }
  update("starting")
  const launch = operation.launch
  const args = ["run", "--foreground"]
  for (const key of ["cwd", "soul", "model", "codexBin"]) {
    const value =
      key === "cwd"
        ? launch.cwd
        : key === "soul"
          ? launch.soul
          : key === "model"
            ? launch.model
            : launch.codexBin
    if (key === "soul" && value === null) args.push("--no-soul")
    else if (typeof value === "string")
      args.push(`--${key === "codexBin" ? "codex-bin" : key}=${value}`)
  }
  const env: NodeJS.ProcessEnv = { ...process.env, LEUCO_HOME: home }
  if (launch.codexHome === null) delete env.CODEX_HOME
  else env.CODEX_HOME = launch.codexHome
  const descriptor = openDaemonLog(home)
  const child = spawn(process.execPath, [resolve(import.meta.dir, "../index.ts"), ...args], {
    detached: true,
    cwd: launch.workingDirectory,
    env,
    stdio: ["ignore", descriptor, descriptor],
  })
  closeSync(descriptor)
  const state: { exited: boolean; error: boolean } = { exited: false, error: false }
  child.on("exit", () => {
    state.exited = true
  })
  child.on("error", () => {
    state.error = true
  })
  child.unref()
  update("starting", null, child.pid ?? null)
  const readyDeadline = Date.now() + 30000
  while (Date.now() < readyDeadline) {
    if (state.exited || state.error)
      throw new Error("Replacement daemon failed to start. Inspect daemon.log and events.")
    try {
      const status = await requestDaemon({ home, path: "/status", timeoutMs: 1000 })
      if (
        typeof status === "object" &&
        status !== null &&
        "pid" in status &&
        status.pid === child.pid &&
        "ready" in status &&
        status.ready === true
      ) {
        update("ready")
        process.exit(0)
      }
    } catch {
      /* An observation timeout does not mean the child exited. */
    }
    await Bun.sleep(200)
  }
  update(
    "uncertain",
    "Replacement process is still alive but readiness was not observed. It was not restarted again.",
  )
} catch (error) {
  current.value = { ...current.value, causes: errorDetails(error) }
  update(
    error instanceof CliError && error.code === "STATE_UNCERTAIN" ? "uncertain" : "failed",
    error instanceof Error ? error.message : "Restart worker failed",
  )
}
