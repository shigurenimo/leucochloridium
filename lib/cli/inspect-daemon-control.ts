import { errorDetails } from "@/error-details"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { inspectRuntimeHealth } from "@/runtime/inspect-runtime-health"
import type { readMaintenance } from "@/maintenance/read-maintenance"

export async function inspectDaemonControl(
  home: string,
  signal?: AbortSignal,
  maintenance: ReturnType<typeof readMaintenance> = null,
) {
  const errors: string[] = []
  const failures: Array<{ phase: string; causes: ReturnType<typeof errorDetails> }> = []
  const ownership: { lease: ReturnType<typeof readDaemonLease>; valid: boolean } = {
    lease: null,
    valid: true,
  }
  try {
    ownership.lease = readDaemonLease(home)
  } catch (error) {
    failures.push({ phase: "lease", causes: errorDetails(error) })
    ownership.valid = false
    errors.push(
      "Daemon lease is invalid; process ownership cannot be verified. Do not delete or kill blindly.",
    )
  }
  const leaseProcessAlive = ownership.lease !== null && isProcessAlive(ownership.lease.pid)
  const recordedPid =
    !leaseProcessAlive && maintenance !== null && "oldPid" in maintenance
      ? ([maintenance.oldPid, maintenance.newPid].find(
          (pid) => pid !== null && isProcessAlive(pid),
        ) ?? null)
      : null
  const processAlive = leaseProcessAlive || recordedPid !== null
  const maintenanceUnresolved =
    maintenance !== null &&
    (maintenance.status === "unreadable" ||
      maintenance.status === "uncertain" ||
      ("workerAlive" in maintenance && maintenance.workerAlive))
  if (ownership.valid && !processAlive)
    errors.push(
      maintenanceUnresolved
        ? "Daemon is unavailable and restart maintenance is active or unverified. Inspect status and logs before manually starting another process."
        : "Daemon is stopped; it cannot receive or answer messages. Run leuco start to bring it online.",
    )
  const observed: { status: unknown; error: string | null } = {
    status:
      ownership.valid && !maintenanceUnresolved
        ? { running: false }
        : { running: null, ready: false, ownership: "unknown" },
    error: null,
  }
  if (recordedPid !== null) {
    observed.status = { running: null, ready: false, pid: recordedPid, ownership: "unknown" }
    observed.error =
      "A recorded daemon PID is alive, but current ownership is missing or stale. Inspect maintenance and process state; do not start a duplicate."
    errors.push(observed.error)
    failures.push({ phase: "identity", causes: errorDetails(new Error(observed.error)) })
  }
  if (leaseProcessAlive) {
    try {
      observed.status = await requestDaemon({
        home,
        path: "/status",
        timeoutMs: 2000,
        signal,
        expectedLease: ownership.lease ?? undefined,
      })
    } catch (error) {
      failures.push({ phase: "control", causes: errorDetails(error) })
      observed.status = { running: true, ready: false, pid: ownership.lease?.pid, reachable: false }
      observed.error =
        "Daemon PID is alive, but authenticated control state could not be verified. Inspect failure causes; do not start a duplicate."
      errors.push(observed.error)
    }
  }
  if (leaseProcessAlive) errors.push(...inspectRuntimeHealth(observed.status).issues)
  return {
    daemon: observed.status,
    controlError: observed.error,
    leaseValid: ownership.valid,
    processAlive,
    staleLease: ownership.lease !== null && !processAlive,
    errors,
    failures,
  }
}
