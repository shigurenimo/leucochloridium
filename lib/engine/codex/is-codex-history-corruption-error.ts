import { CodexRpcError } from "@/engine/codex/codex-rpc-error"

/**
 * The Responses API rejects a persisted rollout when a previously recorded
 * tool-call argument no longer satisfies its input schema. This is local to
 * that thread; authentication, transport, and rate-limit errors must keep the
 * thread id so a transient failure cannot silently discard conversation state.
 */
export const isCodexHistoryCorruptionError = (error: Error): boolean => {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false
  return (
    error.rpcMessage.includes("invalid_request_error") &&
    /input\[\d+\]\.arguments/.test(error.rpcMessage)
  )
}
