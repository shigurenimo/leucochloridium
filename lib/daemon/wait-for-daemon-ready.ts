import { requestDaemon } from "@/daemon/request-daemon"
import { runningDaemonStatusSchema } from "@/daemon/daemon-status-schema"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { awaitAbortableDelay } from "@/await-abortable-delay"

type Props = {
  home: string
  pid: number | null
  timeoutMs: number
  pollMs?: number
  signal?: AbortSignal
  getExitError?: () => Error | null
}

/** Polls only; an unverified observation never starts another process. */
export async function waitForDaemonReady(props: Props) {
  const pollMs = props.pollMs ?? 100
  if (
    !Number.isSafeInteger(props.timeoutMs) ||
    props.timeoutMs < 1 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1
  )
    throw new Error("Readiness observation limits must be positive integers")
  const deadline = performance.now() + props.timeoutMs
  const observation: {
    probes: number
    lastStatus: { at: number; pid: number; ready: boolean } | null
    lastFailure: { at: number; error: unknown } | null
  } = { probes: 0, lastStatus: null, lastFailure: null }
  while (performance.now() < deadline && !props.signal?.aborted) {
    const beforeProbe = props.getExitError?.() ?? null
    if (beforeProbe !== null) throw beforeProbe
    observation.probes += 1
    const status = await requestDaemon({
      home: props.home,
      path: "/status",
      signal: props.signal,
      timeoutMs: Math.max(1, Math.min(1000, Math.ceil(deadline - performance.now()))),
    })
      .then((value) => runningDaemonStatusSchema.parse(value))
      .catch((error: unknown) => {
        observation.lastFailure = { at: Date.now(), error }
        return null
      })
    const afterProbe = props.getExitError?.() ?? null
    if (afterProbe !== null) throw afterProbe
    if (status !== null) {
      observation.lastStatus = { at: Date.now(), pid: status.pid, ready: status.ready }
      if (status.pid === props.pid && status.ready) return status
      if (status.pid !== props.pid)
        observation.lastFailure = {
          at: Date.now(),
          error: new CliError(
            "STATE_CONFLICT",
            `Readiness belongs to PID ${status.pid}, not the spawned PID ${props.pid ?? "unknown"}`,
          ),
        }
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0 || props.signal?.aborted) break
    try {
      await awaitAbortableDelay(Math.min(pollMs, remaining), props.signal)
    } catch (error) {
      if (!props.signal?.aborted) throw error
      break
    }
  }
  const finalExit = props.getExitError?.() ?? null
  if (finalExit !== null) throw finalExit
  const latest = observation.lastStatus
  const failure = new CliError(
    "STATE_UNCERTAIN",
    `Readiness was not confirmed for daemon PID ${props.pid ?? "unknown"}${props.signal?.aborted ? " because observation was cancelled" : ` within ${props.timeoutMs}ms`}. Last verified status: ${latest === null ? "none" : `PID ${latest.pid}, ready=${latest.ready}`}. Inspect status and logs before another start.`,
    {
      phase: "readiness",
      pid: props.pid,
      timeoutMs: props.timeoutMs,
      probes: observation.probes,
      cancelled: props.signal?.aborted ?? false,
      lastStatus: latest,
      lastProbeFailure:
        observation.lastFailure === null
          ? null
          : {
              at: observation.lastFailure.at,
              causes: errorDetails(observation.lastFailure.error),
            },
    },
  )
  if (props.signal?.aborted) failure.cause = props.signal.reason
  else if (observation.lastFailure !== null) failure.cause = observation.lastFailure.error
  throw failure
}
