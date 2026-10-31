import { DaemonHttpRequest } from "@/daemon/daemon-http-request"
import type { DaemonRequest } from "@/daemon/daemon-http-request"

export async function requestDaemonResponse(props: DaemonRequest): Promise<Response> {
  return new DaemonHttpRequest(props).getResponse()
}
