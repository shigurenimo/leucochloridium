import type { DaemonControl } from "@/control/daemon-control"

export type GatewayRouteDeps = {
  selfPid: number
  control: DaemonControl
}
