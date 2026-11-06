import { errorMessage } from "@/error-message"
import { sliceTextPrefix } from "@/slice-text-prefix"

export const MAX_CODEX_NOTIFICATION_PARAMS_CHARS = 16_000

/**
 * Preserve small JSON values as-is while replacing oversized diagnostic
 * payloads with a valid, bounded preview.
 */
export const toBoundedJsonValue = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) return null
    if (serialized.length <= MAX_CODEX_NOTIFICATION_PARAMS_CHARS) return value

    const metadata = {
      truncated: true,
      originalChars: serialized.length,
      message: "Codex notification params were truncated before diagnostic persistence.",
    }
    const emptyEnvelope = JSON.stringify({ _leuco: metadata, preview: "" })
    const previewChars = Math.max(
      0,
      Math.floor((MAX_CODEX_NOTIFICATION_PARAMS_CHARS - emptyEnvelope.length - 256) / 2),
    )
    const preview = sliceTextPrefix(serialized, previewChars)
    const envelope = {
      _leuco: { ...metadata, previewChars: preview.length },
      preview,
    }
    if (JSON.stringify(envelope).length <= MAX_CODEX_NOTIFICATION_PARAMS_CHARS) return envelope

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
