import { redactPublicText } from "@/secrets/redact-public-text"

/** One write stays one physical record; escape complete characters within the output budget. */
export function formatLogLine(line: string): string {
  const redacted = redactPublicText(line)
  const output = { text: "", consumed: 0 }
  for (const character of redacted) {
    const point = character.codePointAt(0)!
    const unicodeControl = (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029
    const escaped = unicodeControl
      ? `\\u${point.toString(16).padStart(4, "0")}`
      : point < 0x20 || character === "\\" || (point >= 0xd800 && point <= 0xdfff)
        ? JSON.stringify(character).slice(1, -1)
        : character
    if (output.text.length + escaped.length > 16000) break
    output.text += escaped
    output.consumed += character.length
  }
  return output.consumed === redacted.length
    ? output.text
    : `${output.text} [truncated log entry; redacted chars=${redacted.length}]`
}
