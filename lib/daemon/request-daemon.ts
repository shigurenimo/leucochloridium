import { requestDaemonResponse } from "@/daemon/request-daemon-response"
import type { DaemonRequest } from "@/daemon/request-daemon-response"
export async function requestDaemon(props: DaemonRequest): Promise<unknown> {
  return (await requestDaemonResponse(props)).json()
}
