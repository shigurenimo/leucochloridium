import type { DaemonPidLease } from "@/daemon/daemon-pid-lease"

type Props = {
  pid: number
  processCommand: string | null
  processIdentity: string | null
}

const LEUCO_DAEMON_COMMAND =
  /(?:^|\s)(?:\S*\/)?bun\s+\S*\/(?:node_modules\/)?leuco[^/\s]*\/lib\/index\.ts\s+run(?:\s|$)/

// This directory is the complete pre-0.16 compatibility boundary. Remove it
// together with DaemonProcessPort.getCommand after the migration window.
export const toVerifiedLegacyDaemonPidLease = (props: Props): DaemonPidLease | null => {
  if (props.processCommand === null || props.processIdentity === null) return null
  if (!LEUCO_DAEMON_COMMAND.test(props.processCommand)) return null

  return {
    version: 1,
    pid: props.pid,
    processIdentity: props.processIdentity,
  }
}
