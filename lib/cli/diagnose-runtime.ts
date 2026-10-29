import { errorDetails } from "@/error-details"
import { inspectRuntimeHealth } from "@/runtime/inspect-runtime-health"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import pkg from "../../package.json" with { type: "json" }
import { settingsSchema } from "@/config/config-schema"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
import { readMaintenance } from "@/maintenance/read-maintenance"
import type { LeucoEvent } from "@/events/leuco-event-types"

export async function diagnoseRuntime(home: string, signal?: AbortSignal) {
  const store = new NodeLeucoStore(home)
  const errors: string[] = []
  const failures: Array<{ phase: string; causes: ReturnType<typeof errorDetails> }> = []
  const configuration = { settings: settingsSchema.parse({}), valid: true, stateValid: true }
  try {
    configuration.settings = store.loadSettings()
  } catch (error) {
    failures.push({ phase: "settings", causes: errorDetails(error) })
    configuration.valid = false
    errors.push("Settings are invalid/unreadable; contents were not overwritten")
  }
  try {
    store.loadState()
  } catch (error) {
    failures.push({ phase: "state", causes: errorDetails(error) })
    configuration.stateValid = false
    errors.push(
      "Runtime state is invalid; verify the daemon is stopped before repair --reset-state archives it without deleting Codex history",
    )
  }
  const launch: { value: LaunchConfiguration | null } = { value: null }
  try {
    launch.value = new NodeMaintenanceStore(home).readLaunch()
  } catch (error) {
    failures.push({ phase: "launch", causes: errorDetails(error) })
    errors.push("Recorded launch options are invalid; preserve launch.json for inspection")
  }
  const cwd =
    launch.value?.cwd ??
    configuration.settings.cwd ??
    launch.value?.workingDirectory ??
    process.cwd()
  const cwdExists = existsSync(cwd) && statSync(cwd).isDirectory()
  const codex = launch.value?.codexBin
    ? existsSync(launch.value.codexBin)
      ? launch.value.codexBin
      : null
    : Bun.which("codex", { PATH: process.env.PATH })
  const cli = Bun.which("leuco", { PATH: process.env.PATH })
  const soul = launch.value?.soul === undefined ? configuration.settings.soul : launch.value.soul
  const soulExists = soul === null || existsSync(soul)
  if (!cwdExists) errors.push(`Working directory is missing or is not a directory: ${cwd}`)
  if (codex === null)
    errors.push("Codex executable was not found; install Codex or correct --codex-bin/PATH")
  if (!soulExists) errors.push(`SOUL file is missing: ${soul}; correct the path or use --no-soul`)
  if (configuration.settings.slack !== null && cli === null)
    errors.push(
      "Slack replies require leuco on PATH. Run bun link in the Leuco checkout, include Bun's bin directory in PATH, then restart the daemon to inherit it. This check observes the invoking CLI's PATH.",
    )
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
  const processAlive = ownership.lease !== null && isProcessAlive(ownership.lease.pid)
  if (ownership.valid && !processAlive)
    errors.push(
      "Daemon is stopped; it cannot receive or answer messages. Run leuco start to bring it online.",
    )
  const observed: { status: unknown; error: string | null } = {
    status: ownership.valid
      ? { running: false }
      : { running: null, ready: false, ownership: "unknown" },
    error: null,
  }
  if (processAlive) {
    try {
      observed.status = await requestDaemon({ home, path: "/status", timeoutMs: 2000, signal })
    } catch (error) {
      failures.push({ phase: "control", causes: errorDetails(error) })
      observed.status = { running: true, ready: false, pid: ownership.lease?.pid, reachable: false }
      observed.error =
        "Daemon PID is alive but authenticated control did not respond. Inspect logs; do not start a duplicate."
      errors.push(observed.error)
    }
  }
  const health = processAlive
    ? inspectRuntimeHealth(observed.status)
    : { healthy: true, issues: [] }
  const daemonHealthy = health.healthy
  errors.push(...health.issues)
  const history: {
    entries: Array<{ seq: number; ts: number; event: LeucoEvent }>
    valid: boolean
  } = { entries: [], valid: true }
  if (existsSync(join(home, "events.db"))) {
    try {
      history.entries = readLeucoEvents(join(home, "events.db"), 100)
    } catch (error) {
      failures.push({ phase: "event-log", causes: errorDetails(error) })
      history.valid = false
      errors.push("Event database is unreadable; preserve it for inspection. It was not replaced.")
    }
  }
  const recentFailures = history.entries
    .filter(
      (entry) =>
        (entry.event.type === "turn.error" && !entry.event.cancelled) ||
        entry.event.type === "slack.error" ||
        (entry.event.type === "log" && entry.event.level === "error"),
    )
    .slice(0, 10)
  const maintenance = readMaintenance(home)
  if (maintenance && "eventLogError" in maintenance && maintenance.eventLogError)
    errors.push(`Maintenance event persistence failed: ${maintenance.eventLogError}`)
  if (!processAlive && maintenance && ["failed", "uncertain"].includes(maintenance.status))
    errors.push(
      `Latest restart is ${maintenance.status}: ${maintenance.error ?? "Inspect maintenance progress and logs"}`,
    )
  if (maintenance?.status === "unreadable")
    errors.push("Maintenance journal is invalid; preserve it for inspection")
  return {
    cwd,
    cwdExists,
    codex,
    cli,
    codexHome: launch.value
      ? (launch.value.codexHome ?? join(homedir(), ".codex"))
      : (process.env.CODEX_HOME ?? join(homedir(), ".codex")),
    soulExists,
    slackConfigured: configuration.settings.slack !== null,
    versions: {
      leuco: pkg.version,
      bun: Bun.version,
      flume: pkg.dependencies["@interactive-inc/flume"],
    },
    daemon: observed.status,
    controlError: observed.error,
    staleLease: ownership.lease !== null && !processAlive,
    maintenance,
    launch: launch.value,
    settingsValid: configuration.valid,
    stateValid: configuration.stateValid,
    leaseValid: ownership.valid,
    eventLogValid: history.valid,
    recentFailures,
    errors,
    failures,
    repairable: {
      staleLease: ownership.lease !== null && !processAlive,
      invalidState: !configuration.stateValid && ownership.valid && !processAlive,
    },
    healthy:
      cwdExists &&
      codex !== null &&
      soulExists &&
      configuration.valid &&
      configuration.stateValid &&
      ownership.valid &&
      history.valid &&
      daemonHealthy &&
      errors.length === 0,
    hints: [
      "Use events --request <requestId> to reconstruct one request.",
      "Use status to inspect active request, last activity, queue depth, log health and maintenance progress.",
      "Do not replay failed writes or agent prompts automatically.",
      "Credential setup is clipboard-only: copy one token and run slack login bot or slack login app.",
    ],
  }
}
