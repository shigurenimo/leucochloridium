import { CodexRpcError } from "@/engine/codex/codex-rpc-error"
import { CodexTurnError } from "@/engine/codex/codex-turn-error"

const isHistoryValidationText = (text: string): boolean =>
  text.includes("invalid_request_error") && /input\[\d+\]\.arguments/.test(text)

/**
 * The Responses API rejects a persisted rollout when a previously recorded
 * tool-call argument no longer satisfies its input schema. This is local to
 * that thread; authentication, transport, and rate-limit errors must keep the
 * thread id so a transient failure cannot silently discard conversation state.
 * Only Codex's own text counts: a JSON-RPC invalid request or a failed turn.
 */
export const isCodexHistoryCorruptionError = (error: Error): boolean => {
  if (error instanceof CodexRpcError)
    return error.code === -32600 && isHistoryValidationText(error.rpcMessage)
  if (error instanceof CodexTurnError)
    return (
      error.status === "failed" &&
      error.turnMessage !== null &&
      isHistoryValidationText(error.turnMessage)
    )
  return false
}
