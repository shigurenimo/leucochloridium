import { errorDetails } from "@/error-details"
import { CliError } from "@/cli/cli-error"
import { join } from "node:path"
import type { DaemonLease } from "@/daemon/daemon-lease"
import { readDaemonLease } from "@/daemon/daemon-lease"

export type DaemonRequest = {
  home: string
  path: string
  body?: unknown
  timeoutMs?: number
  requestId?: string
  expectedLease?: DaemonLease
  signal?: AbortSignal
}
export async function requestDaemonResponse(props: DaemonRequest): Promise<Response> {
  const lease = readDaemonLease(props.home)
  if (lease === null) throw new CliError("NOT_RUNNING", "Leuco is not running; run leuco start")
  if (
    props.expectedLease &&
    (lease.token !== props.expectedLease.token || lease.pid !== props.expectedLease.pid)
  )
    throw new CliError(
      "STATE_CONFLICT",
      "Daemon identity changed before the request; refusing to control another instance",
    )
  const multipart = props.body instanceof FormData
  const response = await fetch(`http://localhost${props.path}`, {
    unix: join(props.home, "control.sock"),
    method: props.body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${lease.token}`,
      ...(props.requestId ? { "x-leuco-request-id": props.requestId } : {}),
      ...(multipart ? {} : { "content-type": "application/json" }),
    },
    ...(props.body === undefined
      ? {}
      : { body: props.body instanceof FormData ? props.body : JSON.stringify(props.body) }),
    signal: props.signal
      ? props.timeoutMs === undefined
        ? props.signal
        : AbortSignal.any([props.signal, AbortSignal.timeout(props.timeoutMs)])
      : AbortSignal.timeout(props.timeoutMs ?? 5000),
  }).catch((error: unknown) => {
    throw new CliError(
      "STATE_UNCERTAIN",
      "Cannot observe daemon response. Inspect status, logs and operation history before retrying.",
      { transport: errorDetails(error) },
    )
  })
  if (response.ok) return response
  const payload: unknown = await response.json()
  const message =
    typeof payload === "object" && payload !== null && "error" in payload
      ? String(payload.error)
      : `Daemon returned ${response.status}`
  throw new CliError(
    response.status === 401 || response.status === 503 ? "STATE_CONFLICT" : "OPERATION_FAILED",
    message,
    { daemon: payload, status: response.status },
  )
}
