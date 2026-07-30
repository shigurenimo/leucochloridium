import type { ConversationScope } from "@/config/config-schema"
import { errorMessage } from "@/error-message"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"

type Logger = (line: string) => void

type ProjectStateStorePort = Pick<LeucoProjectStateStore, "setCodexThreadId" | "setCodexThreadIds">

export type ProjectThreadSummary = {
  threadKey: string
  threadId: string
}

export type ProjectThreadRegistryProps = {
  projectId: string
  projectName: string
  scope: ConversationScope
  initialThreadId?: string
  initialThreadIds?: Readonly<Record<string, string>>
  stateStore?: ProjectStateStorePort
  onLog: Logger
}

/** Owns persisted and live Codex thread identity for one project runtime. */
export class ProjectThreadRegistry {
  private readonly projectId: string
  private readonly projectName: string
  private readonly scope: ConversationScope
  private readonly stateStore: ProjectStateStorePort | null
  private readonly log: Logger
  private projectThreadId: string | null
  private readonly threadIds: Map<string, string>
  private readonly liveThreadIds = new Set<string>()

  constructor(props: ProjectThreadRegistryProps) {
    this.projectId = props.projectId
    this.projectName = props.projectName
    this.scope = props.scope
    this.stateStore = props.stateStore ?? null
    this.log = props.onLog
    this.projectThreadId = props.initialThreadId ?? null
    this.threadIds = new Map(Object.entries(props.initialThreadIds ?? {}))
  }

  conversationKey(threadKey: string): string {
    return this.scope === "project" ? this.projectName : threadKey
  }

  list(): ProjectThreadSummary[] {
    if (this.scope === "project") {
      if (this.projectThreadId === null) return []
      return [{ threadKey: this.projectName, threadId: this.projectThreadId }]
    }
    return Array.from(this.threadIds, ([threadKey, threadId]) => ({
      threadKey,
      threadId,
    })).sort((a, b) => a.threadKey.localeCompare(b.threadKey))
  }

  clear(threadKeyOrId: string): boolean {
    if (this.scope === "project") {
      if (threadKeyOrId !== this.projectName && threadKeyOrId !== this.projectThreadId) {
        return false
      }
      if (this.projectThreadId === null) return false

      this.liveThreadIds.delete(this.projectThreadId)
      this.projectThreadId = null
      this.persist()
      return true
    }

    const entry = Array.from(this.threadIds).find(
      (candidate) => candidate[0] === threadKeyOrId || candidate[1] === threadKeyOrId,
    )
    if (entry === undefined) return false

    this.threadIds.delete(entry[0])
    this.liveThreadIds.delete(entry[1])
    this.persist()
    return true
  }

  get(conversationKey: string): string | null {
    if (this.scope === "project") return this.projectThreadId
    return this.threadIds.get(conversationKey) ?? null
  }

  set(conversationKey: string, threadId: string | null): void {
    if (this.scope === "project") {
      this.projectThreadId = threadId
      return
    }
    if (threadId === null) {
      this.threadIds.delete(conversationKey)
      return
    }
    this.threadIds.set(conversationKey, threadId)
  }

  discard(conversationKey: string, reason: string): void {
    const threadId = this.get(conversationKey)
    this.log(`[leuco] thread ${threadId ?? "unknown"} ${reason}; starting a new thread`)
    if (threadId !== null) this.liveThreadIds.delete(threadId)
    this.set(conversationKey, null)
    this.persist()
  }

  isLive(threadId: string): boolean {
    return this.liveThreadIds.has(threadId)
  }

  markLive(threadId: string): void {
    this.liveThreadIds.add(threadId)
  }

  clearLive(): void {
    this.liveThreadIds.clear()
  }

  persist(): void {
    const store = this.stateStore
    if (store === null) return

    try {
      if (this.scope === "project") {
        store.setCodexThreadId(this.projectId, this.projectThreadId)
        return
      }
      store.setCodexThreadIds(this.projectId, Object.fromEntries(this.threadIds))
    } catch (err) {
      this.log(`[leuco] failed to persist threads: ${errorMessage(err)}`)
    }
  }
}
