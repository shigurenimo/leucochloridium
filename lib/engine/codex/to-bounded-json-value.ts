import { errorMessage } from "@/error-message"

export const MAX_CODEX_NOTIFICATION_PARAMS_CHARS = 16_000

const MIN_BOUNDED_JSON_CHARS = 512

/**
 * Preserve small JSON values as-is while replacing oversized diagnostic
 * payloads with a valid, bounded preview.
 */
export const toBoundedJsonValue = (
  value: unknown,
  maxChars = MAX_CODEX_NOTIFICATION_PARAMS_CHARS,
): unknown => {
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_BOUNDED_JSON_CHARS) {
    throw new Error(`maxChars must be an integer >= ${MIN_BOUNDED_JSON_CHARS}`)
  }

  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    if (serialized.length <= maxChars) return value

    const metadata = {
      truncated: true,
      originalChars: serialized.length,
      message: "Codex notification params were truncated before diagnostic persistence.",
    }
    const emptyEnvelope = JSON.stringify({ _leuco: metadata, preview: "" })
    const previewChars = Math.max(0, Math.floor((maxChars - emptyEnvelope.length - 256) / 2))
    const envelope = {
      _leuco: { ...metadata, previewChars },
      preview: serialized.slice(0, previewChars),
    }
    if (JSON.stringify(envelope).length <= maxChars) return envelope

    return { _leuco: { ...metadata, previewChars: 0 }, preview: "" }
  } catch (error) {
    return {
      _leuco: {
        truncated: true,
        originalChars: null,
        previewChars: 0,
        message: `Codex notification params could not be serialized: ${errorMessage(error)}`,
      },
      preview: "",
    }
  }
}
