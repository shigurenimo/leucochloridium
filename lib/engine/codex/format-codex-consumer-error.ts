import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { errorMessage } from "@/error-message"
import { formatLogLine } from "@/format-log-line"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

type Props = {
  error: unknown
  redactLogText?: (text: string) => string
}

export function formatCodexConsumerError(props: Props): string {
  const prefix = "[codex notification consumer failed]"
  const message = `${prefix} ${errorMessage(props.error)}`
  try {
    const safe = props.redactLogText === undefined ? message : props.redactLogText(message)
    return truncateDiagnosticText(formatLogLine(safe), MAX_DIAGNOSTIC_MESSAGE_CHARACTERS)
  } catch {
    return `${prefix} [diagnostic omitted: redaction failed]`
  }
}
