import { createDaemonFailure } from "@/daemon/create-daemon-failure"
import { errorMessage } from "@/error-message"
import { redactPublicText } from "@/secrets/redact-public-text"
import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

type Props = {
  error: unknown
  status: number
  requestId: string
  reportError?: (error: unknown, requestId: string) => string
  fallback?: string
  redactionSecrets?: ReadonlyArray<string>
}

export function daemonErrorResponse(props: Props): Response {
  const message =
    props.reportError?.(props.error, props.requestId) ?? props.fallback ?? errorMessage(props.error)
  const failure = createDaemonFailure(props.error, props.redactionSecrets ?? [])
  return Response.json(
    {
      error: truncateDiagnosticText(
        redactPublicText(message, props.redactionSecrets),
        MAX_DIAGNOSTIC_MESSAGE_CHARACTERS,
      ),
      requestId: props.requestId,
      ...(failure === null ? {} : { failure }),
    },
    { status: props.status },
  )
}
