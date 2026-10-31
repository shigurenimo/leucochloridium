import { MAX_THREAD_KEY_CHARACTERS, MAX_TURN_INPUT_BYTES } from "@/turn-input-limits"

export const SCHEDULE_CONNECTOR_NAME = "schedule"
export const SCHEDULE_THREAD_KEY_PREFIX = `${SCHEDULE_CONNECTOR_NAME}:`

export function prepareScheduleInput(entry: {
  id: string
  name: string
  runAt: string
  prompt: string
}) {
  const threadKey = `${SCHEDULE_THREAD_KEY_PREFIX}${entry.id}`
  if (!entry.id || threadKey.length > MAX_THREAD_KEY_CHARACTERS)
    throw new Error(
      `Scheduled thread key must contain 1-${MAX_THREAD_KEY_CHARACTERS} UTF-16 code units`,
    )
  if (!entry.prompt.trim()) throw new Error("Scheduled prompt must contain non-whitespace text")
  const text = [
    `<schedule connector="${SCHEDULE_CONNECTOR_NAME}" entry="${entry.name}" run-at="${entry.runAt}">`,
    entry.prompt,
    "</schedule>",
  ].join("\n")
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > MAX_TURN_INPUT_BYTES)
    throw new Error(
      `Scheduled input including context exceeds ${MAX_TURN_INPUT_BYTES} UTF-8 bytes (${bytes}); reduce the prompt or metadata`,
    )
  return { threadKey, text }
}
