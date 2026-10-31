import { waitForDaemonExit } from "@/daemon/wait-for-daemon-exit"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { errorDetails } from "@/error-details"
import { z } from "zod"
import { CliError } from "@/cli/cli-error"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"

type Props = { home: string; requestId: string; signal?: AbortSignal }

export async function stopDaemon(props: Props) {
  const home = props.home
  const requestId = props.requestId
  const signal = props.signal
  const lease = readDaemonLease(home)
  if (lease === null || !isProcessAlive(lease.pid)) {
    assertRecordedDaemonsStopped(new NodeMaintenanceStore(home).readOperation(), isProcessAlive)
    return { running: false }
  }
  const stopped = z.object({ stopped: z.boolean(), processWillExit: z.boolean() }).parse(
    await requestDaemon({
      home,
      path: "/stop",
      body: {},
      requestId,
      signal,
      expectedLease: lease,
    }),
  )
  if (!stopped.stopped)
    throw new CliError(
      "STATE_UNCERTAIN",
      "Shutdown was requested but resource closure was not confirmed; inspect status and events",
    )
  if (stopped.processWillExit) {
    await waitForDaemonExit(lease.pid, signal).catch((cause: unknown) => {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Leuco resources stopped but process exit was not confirmed${signal?.aborted ? " because observation was cancelled" : ""}; inspect status and logs before another start`,
        {
          phase: "process-exit",
          pid: lease.pid,
          resourcesStopped: true,
          cancelled: signal?.aborted ?? false,
          causes: errorDetails(cause),
        },
      )
      failure.cause = cause
      throw failure
    })
  }
  return { stopped: true }
}
