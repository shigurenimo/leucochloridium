import type { Project } from "@/config/config-schema"
import type { DaemonStartOutcome, StopDaemonPort } from "@/daemon/daemon-control"
import { stopDaemonAndVerify } from "@/daemon/daemon-control"
import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import { errorMessage } from "@/error-message"
import type { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  project: Project
  store: Pick<LeucoProjectStore, "remove" | "updateProject">
  daemon: StopDaemonPort & Pick<LeucoDaemon, "reload">
  restart: () => Promise<DaemonStartOutcome | Error>
}

export type RemoveProjectOutcome = {
  daemonWasRunning: boolean
  restarted: DaemonStartOutcome | null
}

/**
 * Remove config/runtime files only after a live daemon has drained every
 * tenant. This deliberately stops the whole daemon: SIGHUP has no completion
 * handshake, while LeucoDaemon.stop() is synchronous and owner-verified.
 */
export const removeProjectSafely = async (props: Props): Promise<RemoveProjectOutcome | Error> => {
  const daemonWasRunningInitially = props.daemon.status().isRunning
  try {
    props.store.updateProject(props.project.id, (fresh) => ({ ...fresh, enabled: false }))
  } catch (error) {
    return new Error(`failed to disable project before removal: ${errorMessage(error)}`)
  }

  if (daemonWasRunningInitially) {
    props.daemon.reload()
  }
  // Check even when the first status was stopped. launchd may have started
  // the job between the observation and the persisted disable.
  const stopped = stopDaemonAndVerify(props.daemon)
  if (stopped instanceof Error) {
    return new Error(
      `daemon did not stop; project remains registered but disabled: ${stopped.message}`,
    )
  }
  const daemonWasRunning = daemonWasRunningInitially || stopped.wasRunning

  let removeError: Error | null = null
  try {
    props.store.remove(props.project.id)
  } catch (error) {
    removeError = new Error(errorMessage(error))
  }

  if (!daemonWasRunning) {
    if (removeError !== null) {
      return new Error(`project removal did not complete: ${removeError.message}`)
    }
    return { daemonWasRunning: false, restarted: null }
  }

  const restarted = await restartSafely(props.restart)
  if (restarted instanceof Error) {
    if (removeError !== null) {
      return new Error(
        `project removal did not complete (${removeError.message}); daemon restart also failed: ${restarted.message}`,
      )
    }
    return new Error(`project was removed but daemon restart failed: ${restarted.message}`)
  }
  if (removeError !== null) {
    return new Error(
      `project removal did not complete, but daemon was restarted: ${removeError.message}`,
    )
  }
  return { daemonWasRunning: true, restarted }
}

const restartSafely = async (
  restart: () => Promise<DaemonStartOutcome | Error>,
): Promise<DaemonStartOutcome | Error> => {
  try {
    return await restart()
  } catch (error) {
    return new Error(errorMessage(error))
  }
}
