import type { DaemonFailure } from "@/daemon/daemon-failure-schema"

/** Only guards reached before callbacks can confirm that execution did not begin. */
export function daemonRejectionResponse(props: {
  status: 401 | 503
  phase: "authorization" | "readiness" | "availability"
  message: string
  requestId: string
}): Response {
  const failure: DaemonFailure = {
    schemaVersion: 1,
    code: "STATE_CONFLICT",
    details: { phase: props.phase, executionStarted: false },
    causes: [],
  }
  return Response.json(
    { error: props.message, requestId: props.requestId, failure },
    { status: props.status },
  )
}
