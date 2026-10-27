import type { CodexClientPort, CodexTurnOptions } from "@/engine/codex/codex-client-port"
import type { ThreadStartParams, ThreadResumeParams } from "@/engine/codex/codex-types"
import type { ThreadStartResult } from "@/engine/codex/codex-schemas"

export class MemoryCodexClient implements CodexClientPort {
  readonly starts: ThreadStartParams[] = []
  readonly resumes: ThreadResumeParams[] = []
  readonly turns: Array<{ threadId: string; text: string }> = []
  startCount = 0
  stopCount = 0
  nativeInstructions = ""
  startError: Error | null = null
  resumeOutcome: "found" | "missing" | Error = "found"
  reply: string | Error = "done"
  hold = false
  private running = false
  private readonly held: Array<(reply: string | Error) => void> = []

  async start(): Promise<void> {
    this.startCount += 1
    if (this.startError !== null) throw this.startError
    this.running = true
  }

  async stop(): Promise<void> {
    this.stopCount += 1
    this.running = false
    for (const complete of this.held.splice(0)) complete(new Error("Codex stopped"))
  }

  isRunning(): boolean {
    return this.running
  }
  async getDeveloperInstructions(): Promise<string> {
    return this.nativeInstructions
  }

  async startThread(params: ThreadStartParams): Promise<ThreadStartResult> {
    this.starts.push(params)
    return { thread: { id: `thread-${this.starts.length}` } }
  }

  async resumeThread(params: ThreadResumeParams): Promise<ThreadStartResult | Error | null> {
    this.resumes.push(params)
    if (this.resumeOutcome === "missing") return null
    if (this.resumeOutcome instanceof Error) return this.resumeOutcome
    return { thread: { id: params.threadId } }
  }

  async runTextTurn(
    threadId: string,
    text: string,
    _options?: string | CodexTurnOptions,
  ): Promise<string | Error> {
    this.turns.push({ threadId, text })
    if (this.hold) return new Promise((resolve) => this.held.push(resolve))
    return this.reply
  }

  complete(reply = "done"): void {
    this.held.shift()?.(reply)
  }
}
