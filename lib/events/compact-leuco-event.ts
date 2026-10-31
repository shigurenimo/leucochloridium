import { sliceTextPrefix } from "@/slice-text-prefix"
import type { LeucoEvent } from "@/events/leuco-event-types"

const MAX_TURN_TEXT_CHARS = 16_000
const MAX_NOTIFICATION_CHARS = 8_000

export function compactLeucoEvent(event: LeucoEvent): LeucoEvent {
  if (event.type === "log" && event.line.length > 16000)
    return { ...event, line: `${sliceTextPrefix(event.line, MAX_TURN_TEXT_CHARS)} [truncated]` }
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

  if (event.type !== "codex.notification") return event

  const serialized = serialize(event.params)
  if (serialized.length <= MAX_NOTIFICATION_CHARS) return event

  return {
    ...event,
    params: {
      truncated: true,
      originalChars: serialized.length,
      preview: sliceTextPrefix(serialized, MAX_NOTIFICATION_CHARS),
    },
  }
}

function serialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}
