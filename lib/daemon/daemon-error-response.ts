import { errorMessage } from "@/error-message"
import { redactPublicText } from "@/secrets/redact-public-text"

type Props = {
  error: unknown
  status: number
  requestId: string
  reportError?: (error: unknown, requestId: string) => string
  fallback?: string
}

export function daemonErrorResponse(props: Props): Response {
  const message =
    props.reportError?.(props.error, props.requestId) ?? props.fallback ?? errorMessage(props.error)
  return Response.json(
    { error: redactPublicText(message).slice(0, 4000), requestId: props.requestId },
    { status: props.status },
  )
}
