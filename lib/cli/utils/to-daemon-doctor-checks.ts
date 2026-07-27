import type { DoctorCheck } from "@/cli/utils/doctor-check"
import { toDaemonLogDoctorCheck } from "@/cli/utils/to-daemon-log-doctor-check"
import { toDaemonPidDoctorChecks } from "@/cli/utils/to-daemon-pid-doctor-checks"
import type { DaemonStatus } from "@/daemon/leuco-daemon"

type Props = {
  daemonStatus: DaemonStatus
  hasPidFile: boolean
  pidText: string | null
  logAgeSeconds: number | null
}

export const toDaemonDoctorChecks = (props: Props): Record<string, DoctorCheck> => {
  const pidChecks = toDaemonPidDoctorChecks(props)
  if (!props.hasPidFile || props.daemonStatus.pid === null) return pidChecks

  return { ...pidChecks, log: toDaemonLogDoctorCheck(props.logAgeSeconds) }
}
