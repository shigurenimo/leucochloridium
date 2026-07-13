import type { LeucoDaemon } from "@/daemon/leuco-daemon"
import { errorMessage } from "@/error-message"
import type { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  projectId: string
  store: Pick<LeucoProjectStore, "updateProject">
  daemon: Pick<LeucoDaemon, "status" | "reload">
  waitForDown: (projectId: string) => Promise<boolean>
}

export type StopProjectTenantResult = {
  disabledForStop: boolean
}

/** Disable a project and wait until its live tenant is gone before destructive work. */
export const stopProjectTenant = async (props: Props): Promise<StopProjectTenantResult | Error> => {
  let disabled = false
  try {
    const daemonWasRunning = props.daemon.status().isRunning
    if (!daemonWasRunning) {
      return {
        disabledForStop: false,
      }
    }

    props.store.updateProject(props.projectId, (fresh) => {
      if (!fresh.enabled) return fresh
      disabled = true
      return { ...fresh, enabled: false }
    })

    const reload = props.daemon.reload()
    if (!reload.signalled) throw new Error("daemon reload signal failed")

    const confirmedDown = await props.waitForDown(props.projectId)
    if (!confirmedDown) throw new Error("tenant shutdown was not confirmed")

    return {
      disabledForStop: disabled,
    }
  } catch (err) {
    if (disabled) {
      try {
        props.store.updateProject(props.projectId, (fresh) => ({ ...fresh, enabled: true }))
        props.daemon.reload()
      } catch {
        // Preserve the original failure; recovery remains best-effort.
      }
    }
    return new Error(`could not stop tenant safely: ${errorMessage(err)}`)
  }
}
