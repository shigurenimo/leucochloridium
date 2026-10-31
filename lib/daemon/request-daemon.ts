import { DaemonHttpRequest } from "@/daemon/daemon-http-request"
import type { DaemonRequest } from "@/daemon/daemon-http-request"

export async function requestDaemon(props: DaemonRequest): Promise<unknown> {
  return new DaemonHttpRequest(props).getJson()
}
