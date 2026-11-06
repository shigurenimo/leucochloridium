import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { recordDaemonExits } from "@/maintenance/record-daemon-exits"
import { recordReplacementExit } from "@/maintenance/record-replacement-exit"
import {
  RESTART_REPLACEMENT_READY_TIMEOUT_MS,
  RESTART_WORKER_PUBLICATION_TIMEOUT_MS,
  RESTART_WORKER_START_DELAY_MS,
} from "@/maintenance/restart-worker-limits"
import { stopReplacedDaemon } from "@/maintenance/stop-replaced-daemon"
import { errorDetails } from "@/error-details"
import { recordMaintenanceOperation } from "@/maintenance/record-maintenance-operation"
import { launchDaemonProcess } from "@/daemon/launch-daemon-process"
import { CliError } from "@/cli/cli-error"
import { resolve } from "node:path"
import { waitForDaemonReady } from "@/daemon/wait-for-daemon-ready"
import { createDaemonStartupError } from "@/daemon/create-daemon-startup-error"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { waitForDaemonExit } from "@/daemon/wait-for-daemon-exit"

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
const launched: { state: ReturnType<typeof launchDaemonProcess> | null } = { state: null }
try {
  const publicationDeadline = performance.now() + RESTART_WORKER_PUBLICATION_TIMEOUT_MS
  while (performance.now() < publicationDeadline) {
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
  await Bun.sleep(RESTART_WORKER_START_DELAY_MS)
  await stopReplacedDaemon({
    operation: current.value,
    lease: readDaemonLease(home),
    isAlive: isProcessAlive,
    requestStop: (lease, timeoutMs) =>
      requestDaemon({
        home,
        path: "/stop",
        body: {},
        timeoutMs,
        expectedLease: lease,
        requestId: operation.id,
      }),
    waitForExit: waitForDaemonExit,
    onStopping: () => update("stopping"),
  })
  assertRecordedDaemonsStopped(current.value, isProcessAlive)
  recordDaemonExits(store, (pid) => !isProcessAlive(pid))
  update("starting")
  const launch = operation.launch
  const args = ["run", "--foreground"]
  if (launch.cwd !== undefined) args.push(`--cwd=${launch.cwd}`)
  if (launch.soul !== undefined)
    args.push(launch.soul === null ? "--no-soul" : `--soul=${launch.soul}`)
  const env: NodeJS.ProcessEnv = { ...process.env, LEUCO_HOME: home }
  if (launch.codexHome === null) delete env.CODEX_HOME
  else env.CODEX_HOME = launch.codexHome
  const state = launchDaemonProcess({
    home,
    arguments: [resolve(import.meta.dir, "../index.ts"), ...args],
    cwd: launch.workingDirectory,
    env,
  })
  launched.state = state
  update("starting", null, state.pid)
  await waitForDaemonReady({
    home,
    pid: state.pid,
    timeoutMs: RESTART_REPLACEMENT_READY_TIMEOUT_MS,
    pollMs: 200,
    requestId: operation.id,
    getExitError: () => {
      if (!state.exited && state.error === null) return null
      const cause = createDaemonStartupError({
        home,
        pid: state.pid,
        exitCode: state.exitCode,
        signal: state.signal,
        spawnError: state.error,
      })
      return new Error(
        `Replacement daemon failed before readiness (pid=${state.pid ?? "unknown"}, exitCode=${state.exitCode ?? "unknown"}, signal=${state.signal ?? "none"}); inspect maintenance causes and daemon.log`,
        { cause },
      )
    },
  })
  update("ready")
} catch (error) {
  if (
    error instanceof CliError &&
    typeof error.details === "object" &&
    error.details !== null &&
    "phase" in error.details &&
    error.details.phase === "launch-cleanup" &&
    "pid" in error.details &&
    (typeof error.details.pid === "number" || error.details.pid === null)
  )
    current.value = { ...current.value, newPid: error.details.pid }
  current.value = { ...current.value, causes: errorDetails(error) }
  recordReplacementExit(store, launched.state)
  update(
    error instanceof CliError && error.code === "STATE_UNCERTAIN" ? "uncertain" : "failed",
    error instanceof Error ? error.message : "Restart worker failed",
  )
}
