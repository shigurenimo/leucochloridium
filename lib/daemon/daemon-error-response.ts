import { createDaemonFailure } from "@/daemon/create-daemon-failure"
import { toPublicDiagnosticMessage } from "@/to-public-diagnostic-message"

type Props = {
  error: unknown
  status: number
  requestId: string
  message: string
  redactionSecrets: ReadonlyArray<string>
}

export function daemonErrorResponse(props: Props): Response {
  const failure = createDaemonFailure(props.error, props.redactionSecrets)
  return Response.json(
    {
      error: toPublicDiagnosticMessage(props.message, props.redactionSecrets),
      requestId: props.requestId,
      ...(failure === null ? {} : { failure }),
    },
    { status: props.status },
  )
}
