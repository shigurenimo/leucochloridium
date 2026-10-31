import { errorDetails } from "@/error-details"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import type { LeucoStore } from "@/storage/leuco-store"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { isCodexHistoryCorruptionError } from "@/engine/codex/is-codex-history-corruption-error"
import type { LeucoEventLog } from "@/events/leuco-event-log"
import { codexThreadIdSchema } from "@/codex-thread-id-schema"

type Props = {
  store: LeucoStore
  codex: CodexClientPort
  cwd: string
  codexHome: string
  soul: string | null
  model: string | null
  eventLog: LeucoEventLog
}
type TurnContext = {
  requestId: string
  isCurrent: () => boolean
  activity: (phase: string) => void
}

/** Native conversation reuse is isolated from queue scheduling and shutdown. */
export class LeucoConversations {
  private readonly liveThreads = new Set<string>()
  private readonly context = { extra: "", instructions: "", hash: "" }

  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  async initialize(): Promise<void> {
    const soul = this.props.soul
    this.context.extra =
      soul === null ? "" : this.props.store.readInstructions(resolve(this.props.cwd, soul))
    await this.refreshNativeInstructions(() => true)
  }

  async refreshNativeInstructions(isCurrent: () => boolean): Promise<void> {
    const native = (await this.props.codex.getDeveloperInstructions?.()) ?? ""
    if (!isCurrent()) return
    const extra = this.context.extra
    this.context.instructions = extra ? [native, extra].filter(Boolean).join("\n\n") : ""
    this.context.hash = createHash("sha256")
      .update(
        JSON.stringify([this.props.codexHome, this.props.cwd, native, extra, this.props.model]),
      )
      .digest("hex")
  }

  clearLiveThreads(): void {
    this.liveThreads.clear()
  }

  async ensure(key: string, turn: TurnContext): Promise<string | Error> {
    turn.activity("loading conversation mapping")
    const threads = this.props.store.loadState().threads
    const saved = Object.hasOwn(threads, key) ? threads[key] : undefined
    if (saved !== undefined && !codexThreadIdSchema.safeParse(saved.id).success)
      return Object.assign(
        new Error("Stored Codex conversation ID is blank; saved mapping retained"),
        {
          code: "CODEX_THREAD_INVALID",
        },
      )
    if (saved?.context === this.context.hash) {
      if (this.liveThreads.has(saved.id)) return saved.id
      turn.activity("resuming stored Codex conversation")
      const resumed = await this.props.codex.resumeThread({
        threadId: saved.id,
        cwd: this.props.cwd,
      })
      if (!turn.isCurrent()) return new Error("Turn was cancelled")
      if (resumed instanceof Error && !isCodexHistoryCorruptionError(resumed)) return resumed
      if (resumed !== null && !(resumed instanceof Error)) {
        if (resumed.thread.id !== saved.id)
          return Object.assign(
            new Error(
              "Codex resumed a different conversation than requested; saved mapping retained",
            ),
            { code: "CODEX_THREAD_MISMATCH" },
          )
        this.liveThreads.add(resumed.thread.id)
        return resumed.thread.id
      }
      const reason = resumed === null ? "missing history" : "invalid history"
      this.props.eventLog.append({
        ts: Date.now(),
        type: "log",
        level: "warn",
        line: `Stored thread ${saved.id} could not be resumed for ${key} (${reason}); creating a new conversation`,
        requestId: turn.requestId,
        ...(resumed instanceof Error
          ? { causes: errorDetails(this.props.eventLog.redactError(resumed)) }
          : {}),
      })
    }
    turn.activity("creating Codex conversation")
    if (!turn.isCurrent()) return new Error("Turn was cancelled")
    const created = await this.props.codex.startThread({
      cwd: this.props.cwd,
      ...(this.context.instructions ? { developerInstructions: this.context.instructions } : {}),
      ...(this.props.model ? { model: this.props.model } : {}),
    })
    if (created instanceof Error) return created
    if (!turn.isCurrent()) return new Error("Turn was cancelled")
    if (!codexThreadIdSchema.safeParse(created.thread.id).success)
      return Object.assign(
        new Error("Codex returned a blank conversation ID; request not dispatched"),
        {
          code: "CODEX_THREAD_INVALID",
        },
      )
    turn.activity("persisting conversation mapping")
    const id = created.thread.id
    this.props.store.updateState((state) => ({
      ...state,
      threads: { ...state.threads, [key]: { id, context: this.context.hash } },
    }))
    this.liveThreads.add(id)
    return id
  }
}
