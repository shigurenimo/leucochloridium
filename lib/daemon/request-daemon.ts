import { requestDaemonResponse } from "@/daemon/request-daemon-response"

export async function requestDaemon(
  home: string,
  path: string,
  body?: unknown,
  timeoutMs: number | null = 5000,
): Promise<unknown> {
  return (await requestDaemonResponse({ home, path, body, timeoutMs })).json()
}
