import { errorMessage } from "@/error-message"
import { formatLogLine } from "@/format-log-line"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

type Props = {
  kind: "log" | "notification"
  error: unknown
  redactLogText?: (text: string) => string
}

export function formatCodexConsumerError(props: Props): string {
  const prefix = `[codex ${props.kind} consumer failed]`
  const message = `${prefix} ${errorMessage(props.error)}`
  try {
    const safe = props.redactLogText === undefined ? message : props.redactLogText(message)
    return truncateDiagnosticText(formatLogLine(safe), 4000)
  } catch {
    return `${prefix} [diagnostic omitted: redaction failed]`
  }
}
