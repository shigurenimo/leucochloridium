import type { ThreadStartResult } from "@/engine/codex/codex-schemas"
import type { ThreadResumeParams, ThreadStartParams } from "@/engine/codex/codex-types"

/**
 * Structural contract the engine relies on. `LeucoCodexClient` implements this
 * by shape; tests can substitute any matching object without touching the
 * concrete class (whose private members otherwise block ad-hoc fakes).
 */
export type CodexClientPort = {
  start(): Promise<void>
  stop(): Promise<void>
  isRunning(): boolean
  startThread(params: ThreadStartParams): Promise<ThreadStartResult>
  /** Resolves to `null` when the thread is not present in codex's sqlite —
   * caller should fall back to `startThread`. */
  resumeThread(params: ThreadResumeParams): Promise<ThreadStartResult | null>
  runTextTurn(threadId: string, text: string, cwd?: string): Promise<string>
}
