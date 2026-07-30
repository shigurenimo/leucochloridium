import type { LeucoEvent } from "@/events/leuco-event-types"

const MAX_TURN_TEXT_CHARS = 16_000
const MAX_NOTIFICATION_CHARS = 8_000

export function compactLeucoEvent(event: LeucoEvent): LeucoEvent {
  if (event.type === "turn.start" && event.input.length > MAX_TURN_TEXT_CHARS) {
    return {
      ...event,
      input: event.input.slice(0, MAX_TURN_TEXT_CHARS),
      inputChars: event.input.length,
      inputTruncated: true,
    }
  }

  if (event.type === "turn.complete" && event.reply.length > MAX_TURN_TEXT_CHARS) {
    return {
      ...event,
      reply: event.reply.slice(0, MAX_TURN_TEXT_CHARS),
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
      preview: serialized.slice(0, MAX_NOTIFICATION_CHARS),
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
