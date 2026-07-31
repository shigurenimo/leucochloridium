import type { Project } from "@/config/config-schema"
import type { Connector, RunTextTurnOptions } from "@/connectors/connector"
import type {
  DaemonControl,
  DaemonProjectSummary,
  DaemonThreadSummary,
} from "@/control/daemon-control"
import { errorMessage } from "@/error-message"
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { LeucoProjectRuntime } from "@/project/project-runtime"
import { projectRuntimeSignature } from "@/project/project-runtime-signature"
import type { LeucoProjectStore } from "@/projects/project-store"
import { LeucoProjectStateStore } from "@/projects/project-state-store"

type Logger = (line: string) => void

type ProjectRetry = {
  attempt: number
  projectName: string
  signature: string | null
  retryAt: number
  phase: "build" | "start" | "stop"
}

type ProjectSlot = {
  runtime: LeucoProjectRuntime | null
  signature: string | null
  retry: ProjectRetry | null
  paused: boolean
}

type ProjectTarget = {
  project: Project
  signature: string
}

type ProjectTurnProps = {
  projectId: string
  threadKey: string
  text: string
  options?: RunTextTurnOptions
}

export type LeucoProjectSupervisorProps = {
  runtimes: LeucoProjectRuntime[]
  projectStore: LeucoProjectStore
  buildProjectRuntime: (project: Project) => LeucoProjectRuntime
  buildProjectConnector: (project: Project, connectorName: string) => Connector
  onLog?: Logger
  eventLog?: LeucoEventLog
}

const RETRY_INITIAL_MS = 30_000
const RETRY_MAX_MS = 5 * 60_000

/**
 * Reconciles persisted project definitions with their live runtimes.
 *
 * Every project has one slot containing all of its volatile supervisor state.
 * Keeping runtime, signature, retry metadata, and pause state together avoids
 * the cross-map drift that otherwise makes rebuild and shutdown logic fragile.
 */
export class LeucoProjectSupervisor implements DaemonControl {
  private readonly slots = new Map<string, ProjectSlot>()
  private readonly projectStore: LeucoProjectStore
  private readonly buildProjectRuntime: (project: Project) => LeucoProjectRuntime
  private readonly buildProjectConnector: (project: Project, connectorName: string) => Connector
  private readonly projectStateStore: LeucoProjectStateStore
  private readonly log: Logger
  private readonly eventLog: LeucoEventLog
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimerAt: number | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private operationQueue: Promise<void> = Promise.resolve()
  private startInProgress = false
  private stopped = false

  constructor(props: LeucoProjectSupervisorProps) {
    this.projectStore = props.projectStore
    this.buildProjectRuntime = props.buildProjectRuntime
    this.buildProjectConnector = props.buildProjectConnector
    this.projectStateStore = new LeucoProjectStateStore({ paths: props.projectStore.getPaths() })
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.eventLog = props.eventLog ?? new LeucoEventLog()

    for (const runtime of props.runtimes) {
      this.slots.set(runtime.projectId, {
        runtime,
        signature: runtime.configSignature,
        retry: null,
        paused: false,
      })
    }
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise

    this.startPromise = this.runStart()
    return this.startPromise
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise

    this.stopped = true
    this.cancelRetryTimer()
    this.log("[leuco] shutting down")
    this.stopPromise = this.runStop()
    return this.stopPromise
  }

  reconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return this.queueOperation(() => this.runReconcile())
  }

  reload(): Promise<void> {
    return this.reconcile()
  }

  restartProject(projectId: string): Promise<void> {
    return this.queueOperation(async () => {
      const project = this.getProject(projectId)
      if (!project.enabled) throw new Error(`project is disabled: ${project.name}`)

      const slot = this.getOrCreateSlot(project.id)
      slot.paused = false
      await this.stopSlotRuntime(slot)
      await this.startSlotRuntime(project, slot, true)
    })
  }

  restartConnector(projectId: string, connectorName: string): Promise<void> {
    return this.queueOperation(async () => {
      const project = this.getProject(projectId)
      if (!project.enabled) throw new Error(`project is disabled: ${project.name}`)

      const connector = project.connectors.find((candidate) => candidate.name === connectorName)
      if (connector === undefined) throw new Error(`connector not found: ${connectorName}`)
      if (!connector.enabled) throw new Error(`connector is disabled: ${connectorName}`)

      const runtime = this.slots.get(projectId)?.runtime
      if (runtime === null || runtime === undefined) {
        throw new Error(`project runtime is not running: ${project.name}`)
      }
      const replacement = this.buildProjectConnector(project, connectorName)
      await runtime.restartConnector(connectorName, replacement)
    })
  }

  resetProjectSession(projectId: string): Promise<void> {
    return this.queueOperation(async () => {
      const project = this.getProject(projectId)
      const slot = this.getOrCreateSlot(project.id)
      await this.stopSlotRuntime(slot)
      this.projectStateStore.clearCodexThreads(projectId)
      if (project.enabled && !slot.paused) await this.startSlotRuntime(project, slot, true)
    })
  }

  pauseProject(projectId: string): Promise<void> {
    return this.queueOperation(async () => {
      const project = this.getProject(projectId)
      const slot = this.getOrCreateSlot(project.id)
      slot.paused = true
      await this.stopSlotRuntime(slot)
    })
  }

  resumeProject(projectId: string): Promise<void> {
    return this.queueOperation(async () => {
      const project = this.getProject(projectId)
      const slot = this.getOrCreateSlot(project.id)
      slot.paused = false
      if (!project.enabled || slot.runtime !== null) return

      await this.startSlotRuntime(project, slot, true)
    })
  }

  getCwd(): string {
    return this.runningRuntimes()[0]?.projectPath ?? ""
  }

  listProjects(): DaemonProjectSummary[] {
    let projects: Project[]
    try {
      projects = this.getRunnableProjects(true)
    } catch (err) {
      this.log(`[leuco] listProjects: ${errorMessage(err)}`)
      return []
    }

    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      enabled: project.enabled,
      isRunning:
        this.slots.get(project.id)?.runtime !== null &&
        this.slots.get(project.id)?.runtime !== undefined,
    }))
  }

  isCodexRunning(): boolean {
    return this.runningRuntimes().some((runtime) => runtime.isCodexRunning())
  }

  listConnectors(): string[] {
    const names: string[] = []
    for (const runtime of this.runningRuntimes()) {
      for (const name of runtime.listConnectors()) {
        names.push(`${runtime.projectName}:${name}`)
      }
    }
    return names
  }

  listThreads(): DaemonThreadSummary[] {
    const summaries: DaemonThreadSummary[] = []
    for (const runtime of this.runningRuntimes()) {
      for (const thread of runtime.listThreads()) {
        summaries.push({
          project: runtime.projectName,
          threadKey: thread.threadKey,
          threadId: thread.threadId,
        })
      }
    }
    return summaries
  }

  clearThread(threadKey: string): boolean {
    for (const runtime of this.runningRuntimes()) {
      if (runtime.clearThread(threadKey)) return true
    }
    return false
  }

  runProjectTurn(turnProps: ProjectTurnProps): Promise<string | Error> {
    const runtime = this.slots.get(turnProps.projectId)?.runtime

    if (runtime === null || runtime === undefined) {
      return Promise.resolve(new Error(`project runtime is not running: ${turnProps.projectId}`))
    }

    return runtime.runTextTurn(turnProps.threadKey, turnProps.text, turnProps.options)
  }

  private async runStart(): Promise<void> {
    this.startInProgress = true
    try {
      for (const slot of this.slots.values()) {
        const runtime = slot.runtime
        if (runtime === null || this.stopped) break

        try {
          await runtime.start()
          slot.retry = null
        } catch (err) {
          const cleanupError = await this.tryStop(runtime)
          if (cleanupError !== null) {
            this.recordFailure(slot, {
              projectId: runtime.projectId,
              projectName: runtime.projectName,
              signature: runtime.configSignature ?? this.currentSignature(runtime.projectId),
              phase: "stop",
              error: cleanupError,
            })
            continue
          }

          slot.runtime = null
          slot.signature = null
          this.recordFailure(slot, {
            projectId: runtime.projectId,
            projectName: runtime.projectName,
            signature: runtime.configSignature ?? this.currentSignature(runtime.projectId),
            phase: "start",
            error: err,
          })
        }
      }
    } finally {
      this.startInProgress = false
    }

    if (this.stopped) return
    this.scheduleNextRetry()
    const running = this.runningRuntimes()
      .map((runtime) => runtime.projectName)
      .join(", ")
    const retrying = Array.from(this.slots.values())
      .flatMap((slot) => slot.retry?.projectName ?? [])
      .join(", ")
    const suffix = retrying.length > 0 ? `; retrying: ${retrying}` : ""
    this.log(`[leuco] ready — projects: ${running || "(none)"}${suffix}`)
  }

  private async runStop(): Promise<void> {
    await this.startPromise?.catch(() => undefined)
    await this.operationQueue
    await Promise.all(this.runningRuntimes().map((runtime) => this.safeStop(runtime)))
    this.slots.clear()
  }

  private async runReconcile(): Promise<void> {
    let projects: Project[]
    try {
      projects = this.getRunnableProjects(true)
    } catch (err) {
      const reason = errorMessage(err)
      this.log(`[leuco] reconcile: failed to load projects: ${reason}`)
      this.eventLog.append({ ts: Date.now(), type: "supervisor.reconcile.failed", reason })
      this.deferDueRetries()
      this.scheduleNextRetry()
      return
    }

    const targets = new Map<string, ProjectTarget>()
    for (const project of projects) {
      if (!project.enabled) continue
      targets.set(project.id, { project, signature: projectRuntimeSignature(project) })
    }

    const added: string[] = []
    const removed: string[] = []

    for (const entry of Array.from(this.slots.entries())) {
      const projectId = entry[0]
      const slot = entry[1]
      const target = targets.get(projectId)
      if (target !== undefined) continue

      if (slot.runtime !== null) {
        if (this.stopRetryIsDeferred(slot)) continue
        const previousName = slot.runtime.projectName
        if (!(await this.stopSlotRuntime(slot, false))) continue
        removed.push(previousName)
      }
      this.slots.delete(projectId)
    }

    for (const target of targets.values()) {
      const slot = this.getOrCreateSlot(target.project.id)
      if (slot.paused) {
        if (slot.runtime !== null) {
          if (this.stopRetryIsDeferred(slot)) continue
          const previousName = slot.runtime.projectName
          if (!(await this.stopSlotRuntime(slot, false))) continue
          removed.push(previousName)
        }
        continue
      }

      if (slot.runtime !== null && this.stopRetryIsDeferred(slot)) continue

      if (slot.runtime !== null && !this.runtimeNeedsRebuild(slot, target)) {
        slot.retry = null
        continue
      }

      if (slot.runtime !== null) {
        const previousName = slot.runtime.projectName
        this.log(`[leuco] reconcile: rebuilding ${previousName}`)
        if (!(await this.stopSlotRuntime(slot, false))) continue
        removed.push(previousName)
      }

      if (
        slot.retry !== null &&
        slot.retry.signature === target.signature &&
        slot.retry.retryAt > Date.now()
      ) {
        continue
      }
      if (slot.retry?.signature !== target.signature) slot.retry = null

      const started = await this.startSlotRuntime(target.project, slot, false)
      if (started) added.push(target.project.name)
    }

    this.eventLog.append({ ts: Date.now(), type: "supervisor.reconcile", added, removed })
    this.scheduleNextRetry()
  }

  private queueOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.operationQueue.then(async () => {
      await this.startPromise
      if (this.stopped) throw new Error("project supervisor is stopped")
      await operation()
    })
    this.operationQueue = queued.then(
      () => undefined,
      () => undefined,
    )
    return queued
  }

  private async startSlotRuntime(
    project: Project,
    slot: ProjectSlot,
    failLoudly: boolean,
  ): Promise<boolean> {
    const signature = projectRuntimeSignature(project)
    let runtime: LeucoProjectRuntime
    try {
      runtime = this.buildProjectRuntime(project)
    } catch (err) {
      this.recordFailure(slot, {
        projectId: project.id,
        projectName: project.name,
        signature,
        phase: "build",
        error: err,
      })
      if (failLoudly) throw err
      return false
    }

    try {
      await runtime.start()
      slot.runtime = runtime
      slot.signature = signature
      slot.retry = null
      return true
    } catch (err) {
      const cleanupError = await this.tryStop(runtime)
      if (cleanupError !== null) {
        slot.runtime = runtime
        slot.signature = signature
        this.recordFailure(slot, {
          projectId: project.id,
          projectName: project.name,
          signature,
          phase: "stop",
          error: cleanupError,
        })
        if (failLoudly) throw cleanupError
        return false
      }

      this.recordFailure(slot, {
        projectId: project.id,
        projectName: project.name,
        signature,
        phase: "start",
        error: err,
      })
      if (failLoudly) throw err
      return false
    }
  }

  private async stopSlotRuntime(slot: ProjectSlot, failLoudly = true): Promise<boolean> {
    const runtime = slot.runtime
    if (runtime === null) {
      slot.signature = null
      slot.retry = null
      return true
    }

    const stopError = await this.tryStop(runtime)
    if (stopError !== null) {
      this.recordFailure(slot, {
        projectId: runtime.projectId,
        projectName: runtime.projectName,
        signature: runtime.configSignature ?? slot.signature,
        phase: "stop",
        error: stopError,
      })
      if (failLoudly) throw stopError
      return false
    }

    slot.runtime = null
    slot.signature = null
    slot.retry = null
    return true
  }

  private runtimeNeedsRebuild(slot: ProjectSlot, target: ProjectTarget): boolean {
    const runtime = slot.runtime
    if (runtime === null) return true
    if (slot.retry?.phase === "stop") return true
    if (runtime.projectName !== target.project.name) return true
    if (slot.signature !== null) return slot.signature !== target.signature
    if (runtime.configSignature !== null) return runtime.configSignature !== target.signature

    const current = runtime.listConnectors().slice().sort().join(",")
    return current !== enabledConnectorSignature(target.project)
  }

  private stopRetryIsDeferred(slot: ProjectSlot): boolean {
    return slot.retry?.phase === "stop" && slot.retry.retryAt > Date.now()
  }

  private getOrCreateSlot(projectId: string): ProjectSlot {
    const current = this.slots.get(projectId)
    if (current !== undefined) return current

    const created: ProjectSlot = {
      runtime: null,
      signature: null,
      retry: null,
      paused: false,
    }
    this.slots.set(projectId, created)
    return created
  }

  private runningRuntimes(): LeucoProjectRuntime[] {
    return Array.from(this.slots.values()).flatMap((slot) =>
      slot.runtime === null ? [] : [slot.runtime],
    )
  }

  private async safeStop(runtime: LeucoProjectRuntime): Promise<void> {
    await this.tryStop(runtime)
  }

  private async tryStop(runtime: LeucoProjectRuntime): Promise<Error | null> {
    try {
      await runtime.stop()
      return null
    } catch (err) {
      this.log(`[leuco] reconcile: ${runtime.projectName}: stop failed: ${errorMessage(err)}`)
      return err instanceof Error ? err : new Error(errorMessage(err))
    }
  }

  private recordFailure(
    slot: ProjectSlot,
    input: {
      projectId: string
      projectName: string
      signature: string | null
      phase: "build" | "start" | "stop"
      error: unknown
    },
  ): void {
    const previous = slot.retry
    const attempt =
      previous !== null && previous.signature === input.signature ? previous.attempt + 1 : 1
    const now = Date.now()
    const retryDelay = retryDelayMs(attempt)
    const retryAt = now + retryDelay
    const reason = `project runtime ${input.projectName} ${input.phase} failed: ${errorMessage(input.error)}`

    slot.retry = {
      attempt,
      projectName: input.projectName,
      signature: input.signature,
      retryAt,
      phase: input.phase,
    }
    this.log(`[leuco] ${reason}; retry ${attempt} in ${Math.ceil(retryDelay / 1000)}s`)
    this.eventLog.append({
      ts: now,
      type: "supervisor.reconcile.failed",
      reason,
      project: input.projectName,
      attempt,
      retryAt,
    })
    this.scheduleNextRetry()
  }

  private deferDueRetries(): void {
    const now = Date.now()
    for (const slot of this.slots.values()) {
      const retry = slot.retry
      if (retry === null || retry.retryAt > now) continue

      const attempt = retry.attempt + 1
      slot.retry = {
        ...retry,
        attempt,
        retryAt: now + retryDelayMs(attempt),
      }
    }
  }

  private scheduleNextRetry(): void {
    if (this.stopped || this.startInProgress) return

    let retryAt: number | null = null
    for (const slot of this.slots.values()) {
      if (slot.retry === null) continue
      retryAt = retryAt === null ? slot.retry.retryAt : Math.min(retryAt, slot.retry.retryAt)
    }

    if (retryAt === null) {
      this.cancelRetryTimer()
      return
    }
    if (this.retryTimer !== null && this.retryTimerAt === retryAt) return

    this.cancelRetryTimer()
    this.retryTimerAt = retryAt
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null
        this.retryTimerAt = null
        if (this.stopped) return

        void this.reconcile().catch((err: unknown) => {
          const reason = `retry reconcile failed: ${errorMessage(err)}`
          this.log(`[leuco] ${reason}`)
          this.eventLog.append({
            ts: Date.now(),
            type: "supervisor.reconcile.failed",
            reason,
          })
          this.deferDueRetries()
          this.scheduleNextRetry()
        })
      },
      Math.max(0, retryAt - Date.now()),
    )
    this.retryTimer.unref()
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryTimerAt = null
  }

  private currentSignature(projectId: string): string | null {
    try {
      const project = this.getRunnableProjects(false).find(
        (candidate) => candidate.id === projectId,
      )
      return project === undefined ? null : projectRuntimeSignature(project)
    } catch {
      return null
    }
  }

  private getProject(projectId: string): Project {
    const project = this.getRunnableProjects(false).find((candidate) => candidate.id === projectId)
    if (project === undefined) throw new Error(`project not found: ${projectId}`)
    return project
  }

  private getRunnableProjects(shouldReportIssues: boolean): Project[] {
    if (typeof this.projectStore.listRunnable !== "function") return this.projectStore.list()

    const runnable = this.projectStore.listRunnable()
    if (shouldReportIssues) {
      for (const issue of runnable.issues) {
        const reason = `project ${issue.project} is invalid and was skipped: ${issue.error}`
        this.log(`[leuco] ${reason}`)
        this.eventLog.append({
          ts: Date.now(),
          type: "supervisor.reconcile.failed",
          reason,
          project: issue.project,
        })
      }
    }
    return runnable.projects
  }
}

const retryDelayMs = (attempt: number): number => {
  const exponent = Math.min(Math.max(attempt - 1, 0), 4)
  return Math.min(RETRY_INITIAL_MS * 2 ** exponent, RETRY_MAX_MS)
}

const enabledConnectorSignature = (project: Project): string => {
  return project.connectors
    .filter((connector) => connector.enabled)
    .map((connector) => connector.name)
    .slice()
    .sort()
    .join(",")
}
