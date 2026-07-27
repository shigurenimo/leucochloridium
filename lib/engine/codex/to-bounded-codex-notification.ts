import { toBoundedJsonValue } from "@/engine/codex/to-bounded-json-value"
import { toCodexItemCompletedSummary } from "@/engine/codex/to-codex-item-completed-summary"

export type BoundedCodexNotification = {
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
): BoundedCodexNotification | null => {
  if (method.toLowerCase().endsWith("delta")) return null

  const completedSummary = method === "item/completed" ? toCodexItemCompletedSummary(params) : null
  return {
    method: method.slice(0, 256),
    params: toBoundedJsonValue(completedSummary ?? params),
  }
}
