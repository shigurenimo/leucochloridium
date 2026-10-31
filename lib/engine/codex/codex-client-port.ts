import type { LogDeliveryHealth } from "@/log-delivery-health-schema"
import type { ThreadStartResult } from "@/engine/codex/codex-schemas"
import type { ThreadResumeParams, ThreadStartParams } from "@/engine/codex/codex-types"

export type CodexTurnOptions = {
  requestId?: string
  cwd?: string
  onActivity?: (method: string) => void
}

/**
 * Structural contract the engine relies on. `LeucoCodexClient` implements this
 * by shape; tests can substitute any matching object without touching the
 * concrete class (whose private members otherwise block ad-hoc fakes).
 */
export type CodexClientPort = {
  start(): Promise<void>
  stop(): Promise<void>
  getStatus?(): {
    pid: number | null
    ready: boolean
    starting: boolean
    stopping: boolean
    cleaningUp: boolean
    diagnostics?: LogDeliveryHealth
    activeTurns: number
  }
  isRunning(): boolean
  getDeveloperInstructions?(): Promise<string>
  startThread(params: ThreadStartParams): Promise<ThreadStartResult | Error>
  /** Resolves to `null` when the thread is not present in codex's sqlite
   * (caller should fall back to `startThread`), or to `Error` for any other
   * failure (rule: backend functions return `T | Error` instead of throwing). */
  resumeThread(params: ThreadResumeParams): Promise<ThreadStartResult | null | Error>
  runTextTurn(threadId: string, text: string, options?: CodexTurnOptions): Promise<string | Error>
}
