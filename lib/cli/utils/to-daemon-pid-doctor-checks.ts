import type { DoctorCheck } from "@/cli/utils/doctor-check"
import type { DaemonStatus } from "@/daemon/leuco-daemon"

type Props = {
  daemonStatus: DaemonStatus
  hasPidFile: boolean
  pidText: string | null
}

export const toDaemonPidDoctorChecks = (props: Props): Record<string, DoctorCheck> => {
  if (!props.hasPidFile) {
    return {
      pid: { status: "warn", message: "no pid file — daemon is not running" },
      process: { status: "error", message: "daemon not running" },
    }
  }
  if (props.daemonStatus.pid === null) {
    return {
      pid: { status: "error", message: `pid file contains invalid value: ${props.pidText ?? ""}` },
      process: { status: "error", message: "daemon not running" },
    }
  }

  const pid = props.daemonStatus.pid
  return {
    pid: { status: "ok", message: `pid ${pid}` },
    process: props.daemonStatus.isRunning
      ? { status: "ok", message: `process ${pid} alive` }
      : {
          status: "error",
          message: `process ${pid} not found or identity changed — stale pid file`,
        },
  }
}
