import type { DaemonControlClient } from "@/control/daemon-control-client"

type Props<T> = {
  projectId: string
  isDaemonRunning: boolean
  control: Pick<DaemonControlClient, "pauseProject" | "resumeProject">
  operation: () => T | Promise<T>
}

export type PausedProjectOperation<T> = {
  wasPaused: boolean
  value: T
}

export async function withPausedProject<T>(props: Props<T>): Promise<PausedProjectOperation<T>> {
  if (!props.isDaemonRunning) {
    return { wasPaused: false, value: await props.operation() }
  }

  const paused = await props.control.pauseProject(props.projectId)
  if (!paused) throw new Error("daemon control is unavailable")

  try {
    const value = await props.operation()
    const resumed = await props.control.resumeProject(props.projectId)
    if (!resumed) throw new Error("project changed, but daemon control could not resume it")

    return { wasPaused: true, value }
  } catch (error) {
    await props.control.resumeProject(props.projectId).catch(() => false)
    throw error
  }
}
