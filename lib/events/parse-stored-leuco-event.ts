import { leucoEventSchema } from "@/events/leuco-event-schema"
import { redactJsonSecrets } from "@/secrets/redact-json-secrets"

/** Decode escapes before masking; malformed JSON diagnostics must not quote stored content. */
export function parseStoredLeucoEvent(encoded: string, sequence: number) {
  const decoded: unknown = (() => {
    try {
      return JSON.parse(encoded)
    } catch {
      throw new SyntaxError(
        `Stored event JSON is invalid (sequence ${sequence}; ${encoded.length} characters)`,
      )
    }
  })()
  return leucoEventSchema.parse(redactJsonSecrets(decoded, []))
}
