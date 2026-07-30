import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import type { LaunchAgentStatus } from "@/boot/leuco-launch-agent"
import type { DaemonReadinessPort } from "@/daemon/daemon-readiness-port"
import type { DaemonStartResult, LeucoDaemon } from "@/daemon/leuco-daemon"
import { NodeDaemonReadiness } from "@/daemon/node-daemon-readiness"
import { DEFAULT_LEUCO_PORT } from "@/env/cli-env-schema"

type DaemonPort = Pick<LeucoDaemon, "getLogPath" | "start" | "status" | "stop">

export type StopDaemonPort = Pick<LeucoDaemon, "status" | "stop">

type LaunchAgentPort = {
  kickstart(): Promise<void | Error>
  status(): Promise<LaunchAgentStatus | Error>
}

type Props = {
  daemon: DaemonPort
  launchAgent?: LaunchAgentPort
  platform?: NodeJS.Platform
  readiness?: DaemonReadinessPort
  readinessTimeoutMs?: number
  readinessPollIntervalMs?: number
}

type StartProps = Props & {
  binPath: string
  env: NodeJS.ProcessEnv
}

export type DaemonStartOutcome =
  | { mode: "launchd"; label: string; logPath: string }
  | { mode: "detached"; pid: number; logPath: string }

export type DaemonStopOutcome = {
  wasRunning: boolean
  pid: number | null
}

export type WaitForDaemonReadyProps = {
  daemon: Pick<LeucoDaemon, "getLogPath" | "status">
  env: NodeJS.ProcessEnv
  expectedPid: number | null
  readiness?: DaemonReadinessPort
  readinessTimeoutMs?: number
  readinessPollIntervalMs?: number
}

type ReadinessSettings = {
  port: number
  timeoutMs: number
  pollIntervalMs: number
  readiness: DaemonReadinessPort
}

export const daemonSupervisionWarning = (
  outcome: DaemonStartOutcome,
  platform: NodeJS.Platform = process.platform,
): string | null => {
  if (platform !== "darwin" || outcome.mode !== "detached") return null
  return "warning: launchd supervision is inactive; crashes will not restart automatically. run `leuco boot install` to enable it."
}

export const startDaemon = async (props: StartProps): Promise<DaemonStartOutcome | Error> => {
  const readinessSettings = resolveReadinessSettings(props)
  if (readinessSettings instanceof Error) return readinessSettings

  const managed = await resolveManagedAgent(props)
  if (managed instanceof Error) return managed

  if (managed !== null) {
    const kicked = await managed.agent.kickstart()
    if (kicked instanceof Error) return kicked
    const ready = await pollDaemonReadiness(props.daemon, null, readinessSettings)
    if (ready instanceof Error) return ready

    return {
      mode: "launchd",
      label: managed.status.label,
      logPath: props.daemon.getLogPath(),
    }
  }

  try {
    const started = props.daemon.start({ binPath: props.binPath, env: props.env })
    const ready = await pollDaemonReadiness(props.daemon, started.pid, readinessSettings)
    if (ready instanceof Error) {
      stopAfterFailedReadiness(props.daemon)
      return ready
    }
    return detachedOutcome(started)
  } catch (error) {
    return toError(error)
  }
}

export const restartDaemon = async (props: StartProps): Promise<DaemonStartOutcome | Error> => {
  const readinessSettings = resolveReadinessSettings(props)
  if (readinessSettings instanceof Error) return readinessSettings

  const managed = await resolveManagedAgent(props)
  if (managed instanceof Error) return managed

  const stopped = stopDaemonAndVerify(props.daemon)
  if (stopped instanceof Error) return stopped

  if (managed !== null) {
    const kicked = await managed.agent.kickstart()
    if (kicked instanceof Error) return kicked
    const ready = await pollDaemonReadiness(props.daemon, null, readinessSettings)
    if (ready instanceof Error) return ready

    return {
      mode: "launchd",
      label: managed.status.label,
      logPath: props.daemon.getLogPath(),
    }
  }

  try {
    const started = props.daemon.start({ binPath: props.binPath, env: props.env })
    const ready = await pollDaemonReadiness(props.daemon, started.pid, readinessSettings)
    if (ready instanceof Error) {
      stopAfterFailedReadiness(props.daemon)
      return ready
    }
    return detachedOutcome(started)
  } catch (error) {
    return toError(error)
  }
}

export const stopDaemonAndVerify = (daemon: StopDaemonPort): DaemonStopOutcome | Error => {
  const before = daemon.status()
  if (!before.isRunning) return { wasRunning: false, pid: before.pid }

  const stopped = daemon.stop()
  const after = daemon.status()
  if (after.isRunning) {
    return new Error(`daemon pid ${after.pid ?? before.pid ?? "unknown"} did not stop`)
  }
  return { wasRunning: true, pid: stopped.pid }
}

export const waitForDaemonReady = async (props: WaitForDaemonReadyProps): Promise<void | Error> => {
  const settings = resolveReadinessSettings(props)
  if (settings instanceof Error) return settings
  return await pollDaemonReadiness(props.daemon, props.expectedPid, settings)
}

const resolveManagedAgent = async (
  props: Props,
): Promise<{ agent: LaunchAgentPort; status: LaunchAgentStatus } | null | Error> => {
  if ((props.platform ?? process.platform) !== "darwin") return null

  const agent = props.launchAgent ?? new LeucoLaunchAgent()
  const status = await agent.status()
  if (status instanceof Error) return status
  if (!status.isInstalled || !status.isLoaded) return null
  return { agent, status }
}

const detachedOutcome = (started: DaemonStartResult): DaemonStartOutcome => ({
  mode: "detached",
  pid: started.pid,
  logPath: started.logPath,
})

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error))

const stopAfterFailedReadiness = (daemon: Pick<LeucoDaemon, "stop">): void => {
  try {
    daemon.stop()
  } catch {
    // Preserve the readiness error, which carries the diagnostic log path.
  }
}

const resolveReadinessSettings = (
  props: Pick<
    WaitForDaemonReadyProps,
    "env" | "readiness" | "readinessPollIntervalMs" | "readinessTimeoutMs"
  >,
): ReadinessSettings | Error => {
  const port = toGatewayPort(props.env.LEUCO_PORT)
  if (port === null) {
    return new Error(`invalid LEUCO_PORT: ${props.env.LEUCO_PORT ?? ""}`)
  }

  const timeoutMs = props.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  if (!isPositiveInteger(timeoutMs)) {
    return new Error(`invalid daemon readiness timeout: ${timeoutMs}`)
  }

  const pollIntervalMs = props.readinessPollIntervalMs ?? DEFAULT_READINESS_POLL_INTERVAL_MS
  if (!isPositiveInteger(pollIntervalMs)) {
    return new Error(`invalid daemon readiness poll interval: ${pollIntervalMs}`)
  }

  return {
    port,
    timeoutMs,
    pollIntervalMs,
    readiness: props.readiness ?? new NodeDaemonReadiness(),
  }
}

const pollDaemonReadiness = async (
  daemon: Pick<LeucoDaemon, "getLogPath" | "status">,
  expectedPid: number | null,
  settings: ReadinessSettings,
): Promise<void | Error> => {
  const observed = { pid: expectedPid }
  const deadline = settings.readiness.now() + settings.timeoutMs

  while (true) {
    const status = daemon.status()
    const hasVerifiedProcess =
      status.isRunning && status.pid !== null && status.identityVerified !== false

    if (observed.pid !== null && (!hasVerifiedProcess || status.pid !== observed.pid)) {
      return daemonExitedError(observed.pid, daemon.getLogPath())
    }

    if (observed.pid === null && hasVerifiedProcess) {
      observed.pid = status.pid
    }

    const remainingMs = deadline - settings.readiness.now()
    if (hasVerifiedProcess && status.pid !== null && remainingMs > 0) {
      const healthyPid = await getHealthyPid(settings, remainingMs)
      if (healthyPid === status.pid) return undefined
    }

    const waitMs = Math.min(settings.pollIntervalMs, deadline - settings.readiness.now())
    if (waitMs <= 0) {
      return readinessTimeoutError(
        settings,
        daemon.getLogPath(),
        settings.readiness.getDiagnostic(),
      )
    }
    await settings.readiness.sleep(waitMs)
  }
}

const getHealthyPid = async (
  settings: ReadinessSettings,
  remainingMs: number,
): Promise<number | null> => {
  try {
    return await settings.readiness.getHealthyPid({
      port: settings.port,
      timeoutMs: Math.max(1, Math.min(READINESS_REQUEST_TIMEOUT_MS, remainingMs)),
    })
  } catch {
    return null
  }
}

const daemonExitedError = (pid: number, logPath: string): Error => {
  return new Error(
    `daemon pid ${pid} exited or was replaced before gateway became ready; log: ${logPath}`,
  )
}

const readinessTimeoutError = (
  settings: ReadinessSettings,
  logPath: string,
  diagnostic: string | null,
): Error => {
  const detail = diagnostic === null ? "" : `; last probe: ${diagnostic}`
  return new Error(
    `daemon gateway did not become ready at http://127.0.0.1:${settings.port}/health within ${settings.timeoutMs}ms${detail}; log: ${logPath}`,
  )
}

const toGatewayPort = (value: string | undefined): number | null => {
  if (value === undefined) return DEFAULT_LEUCO_PORT
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return port
}

const isPositiveInteger = (value: number): boolean => {
  return Number.isSafeInteger(value) && value > 0
}

const DEFAULT_READINESS_TIMEOUT_MS = 15_000
const DEFAULT_READINESS_POLL_INTERVAL_MS = 100
const READINESS_REQUEST_TIMEOUT_MS = 1_000
