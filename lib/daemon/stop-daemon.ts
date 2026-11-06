import { waitForDaemonExit } from "@/daemon/wait-for-daemon-exit"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import type { MaintenanceStore } from "@/maintenance/maintenance-store"
import { readMaintenanceOperation } from "@/maintenance/read-maintenance-operation"
import { recordDaemonExits } from "@/maintenance/record-daemon-exits"
import { errorDetails } from "@/error-details"
import { z } from "zod"
import { CliError } from "@/cli/cli-error"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"

type Props = {
  home: string
  requestId: string
  signal?: AbortSignal
  maintenance?: MaintenanceStore
}

export async function stopDaemon(props: Props) {
  const home = props.home
  const requestId = props.requestId
  const signal = props.signal
  const maintenance = props.maintenance ?? new NodeMaintenanceStore(home)
  const lease = readDaemonLease(home)
  if (lease === null || !isProcessAlive(lease.pid)) {
    assertRecordedDaemonsStopped(readMaintenanceOperation(maintenance), isProcessAlive)
    return { running: false }
  }
  const acknowledgement = z.object({ processWillExit: z.boolean() }).parse(
    await requestDaemon({
      home,
      path: "/stop",
      body: {},
      requestId,
      signal,
      expectedLease: lease,
    }),
  )
  if (acknowledgement.processWillExit) {
    await waitForDaemonExit(lease.pid, 15_000, signal).catch((cause: unknown) => {
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
    recordDaemonExits(maintenance, (pid) => pid === lease.pid && !isProcessAlive(pid))
  }
  return { stopped: true }
}
