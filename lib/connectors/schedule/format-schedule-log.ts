import type { LeucoEventLog } from "@/events/leuco-event-log"
import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

export function formatScheduleLog(line: string, eventLog: LeucoEventLog): string {
  return truncateDiagnosticText(eventLog.redactText(line), MAX_DIAGNOSTIC_MESSAGE_CHARACTERS)
}
