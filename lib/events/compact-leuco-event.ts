import { sliceTextPrefix } from "@/slice-text-prefix"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"
import type { LeucoEvent } from "@/events/leuco-event-types"

const MAX_LOG_LINE_CHARS = 16_000
const MAX_TURN_TEXT_CHARS = 16_000

export function compactLeucoEvent(event: LeucoEvent): LeucoEvent {
  if (event.type === "log" && event.line.length > MAX_LOG_LINE_CHARS)
    return { ...event, line: truncateDiagnosticText(event.line, MAX_LOG_LINE_CHARS) }
  if (event.type === "turn.start" && event.input.length > MAX_TURN_TEXT_CHARS) {
    return {
      ...event,
      input: sliceTextPrefix(event.input, MAX_TURN_TEXT_CHARS),
      inputChars: event.input.length,
      inputTruncated: true,
    }
  }

  if (event.type === "turn.complete" && event.reply.length > MAX_TURN_TEXT_CHARS) {
    return {
      ...event,
      reply: sliceTextPrefix(event.reply, MAX_TURN_TEXT_CHARS),
      replyChars: event.reply.length,
      replyTruncated: true,
    }
  }

  return event
}
