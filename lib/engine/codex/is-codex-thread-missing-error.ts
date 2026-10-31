import { CodexRpcError } from "@/engine/codex/codex-rpc-error"

export function isCodexThreadMissingError(error: Error, threadId: string): boolean {
  if (!(error instanceof CodexRpcError) || error.code !== -32600) return false
  return [
    `no rollout found for thread id ${threadId}`,
    `thread ${threadId} not found`,
    `thread not found: ${threadId}`,
    `no such thread: ${threadId}`,
  ].includes(error.rpcMessage)
}
