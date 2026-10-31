import { toBoundedJsonValue } from "@/engine/codex/to-bounded-json-value"
import { toCodexItemCompletedSummary } from "@/engine/codex/to-codex-item-completed-summary"
import { sliceTextPrefix } from "@/slice-text-prefix"

type BoundedCodexNotification = {
  method: string
  params: unknown
}

/**
 * Drop high-frequency stream deltas and bound everything retained in the
 * structured event log. Turn collection still receives the original event.
 */
export const toBoundedCodexNotification = (
  method: string,
  params: unknown,
  redaction?: { text: (text: string) => string; value: (value: unknown) => unknown },
): BoundedCodexNotification | null => {
  if (method.toLowerCase().endsWith("delta")) return null

  const completedSummary =
    method === "item/completed" ? toCodexItemCompletedSummary(params, redaction?.text) : null
  const diagnostic =
    completedSummary !== null ? completedSummary : redaction ? redaction.value(params) : params
  return {
    method: sliceTextPrefix(redaction ? redaction.text(method) : method, 256),
    params: toBoundedJsonValue(diagnostic),
  }
}
