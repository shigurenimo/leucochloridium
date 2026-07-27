import type { LaunchAgentInstallResult } from "@/boot/leuco-launch-agent"
import type { DaemonStartOutcome, StopDaemonPort } from "@/daemon/daemon-control"
import { stopDaemonAndVerify } from "@/daemon/daemon-control"
import { errorMessage } from "@/error-message"

type Props = {
  daemon: StopDaemonPort
  install: () => Promise<LaunchAgentInstallResult | Error>
  verify?: () => Promise<void | Error>
  rollback?: () => Promise<void | Error>
  restore: () => Promise<DaemonStartOutcome | Error>
}

/**
 * Prevent a newly bootstrapped LaunchAgent from racing an existing detached
 * daemon for the pid lease and gateway port. If installation fails after the
 * old daemon was drained, restore service before reporting the install error.
 */
export const installLaunchAgentSafely = async (
  props: Props,
): Promise<LaunchAgentInstallResult | Error> => {
  const wasRunningInitially = props.daemon.status().isRunning
  const stopped = stopDaemonAndVerify(props.daemon)
  if (stopped instanceof Error) {
    return new Error(`cannot install LaunchAgent while daemon is still running: ${stopped.message}`)
  }
  const wasRunning = wasRunningInitially || stopped.wasRunning

  const installed = await invokeSafely(props.install)
  if (installed instanceof Error) {
    return await restoreAfterInstallFailure(installed, wasRunning, props.restore)
  }
  if (!props.verify) return installed

  const verified = await invokeSafely(props.verify)
  if (!(verified instanceof Error)) return installed

  const rollback = props.rollback
  if (!rollback) {
    return new Error(
      `LaunchAgent gateway readiness failed (${verified.message}); rollback is unavailable`,
    )
  }

  const rolledBack = await invokeSafely(rollback)
  if (rolledBack instanceof Error) {
    return new Error(
      `LaunchAgent gateway readiness failed (${verified.message}); rollback failed: ${rolledBack.message}`,
    )
  }
  if (!wasRunning) {
    return new Error(`LaunchAgent gateway readiness failed: ${verified.message}`)
  }

  const restored = await invokeSafely(props.restore)
  if (restored instanceof Error) {
    return new Error(
      `LaunchAgent gateway readiness failed (${verified.message}); previous daemon also failed to restart: ${restored.message}`,
    )
  }
  const restoredVia =
    restored.mode === "launchd" ? `launchd (${restored.label})` : `detached pid ${restored.pid}`
  return new Error(
    `LaunchAgent gateway readiness failed: ${verified.message} (previous daemon restored via ${restoredVia})`,
  )
}

const restoreAfterInstallFailure = async (
  installed: Error,
  wasRunning: boolean,
  restore: () => Promise<DaemonStartOutcome | Error>,
): Promise<Error> => {
  if (!wasRunning) return installed

  const restored = await invokeSafely(restore)
  if (restored instanceof Error) {
    return new Error(
      `LaunchAgent install failed (${installed.message}); previous daemon also failed to restart: ${restored.message}`,
    )
  }
  const restoredVia =
    restored.mode === "launchd" ? `launchd (${restored.label})` : `detached pid ${restored.pid}`
  return new Error(
    `LaunchAgent install failed: ${installed.message} (previous daemon restored via ${restoredVia})`,
  )
}

const invokeSafely = async <T>(operation: () => Promise<T | Error>): Promise<T | Error> => {
  try {
    return await operation()
  } catch (error) {
    return new Error(errorMessage(error))
  }
}
