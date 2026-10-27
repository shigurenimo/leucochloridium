import { join } from "node:path"
import { readDaemonLease } from "@/daemon/daemon-lease"

type Props = {
  home: string
  path: string
  body?: unknown
  timeoutMs?: number | null
  signal?: AbortSignal
}
export async function requestDaemonResponse(props: Props): Promise<Response> {
  const lease = readDaemonLease(props.home)
  if (lease === null) throw new Error("Leuco is not running; run leuco start")
  const multipart = props.body instanceof FormData
  const response = await fetch(`http://localhost${props.path}`, {
    unix: join(props.home, "control.sock"),
    method: props.body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${lease.token}`,
      ...(multipart ? {} : { "content-type": "application/json" }),
    },
    ...(props.body === undefined
      ? {}
      : { body: props.body instanceof FormData ? props.body : JSON.stringify(props.body) }),
    ...(props.signal
      ? { signal: props.signal }
      : props.timeoutMs === null
        ? {}
        : { signal: AbortSignal.timeout(props.timeoutMs ?? 5000) }),
  })
  if (response.ok) return response
  const payload: unknown = await response.json()
  const message =
    typeof payload === "object" && payload !== null && "error" in payload
      ? String(payload.error)
      : `Daemon returned ${response.status}`
  throw new Error(message)
}
