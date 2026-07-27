import type { Project } from "@/config/config-schema"
import { tenantConfigSignature } from "@/engine/tenant-config-signature"
import type { LeucoTenant } from "@/engine/tenant"
import { errorMessage } from "@/error-message"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoGatewayServer } from "@/gateway/gateway-server"
import type { LeucoProjectStore } from "@/projects/project-store"

export type LeucoEngineProps = {
  tenants: LeucoTenant[]
  projectStore: LeucoProjectStore
  buildTenant: (project: Project) => LeucoTenant
  /** Production callers supply `port`. It is optional here so tests can drive
   * the engine without bringing up a real Bun.serve gateway. */
  port?: number
  onLog?: (line: string) => void
  bus?: LeucoEventBus
  buildGateway?: GatewayBuilder
}

type Logger = (line: string) => void

type TenantRetryState = {
  attempt: number
  projectName: string
  signature: string | null
  retryAt: number
}

type GatewayLifecycle = {
  start(): unknown
  stop(): Promise<void>
}

type GatewayBuilder = (props: {
  engine: LeucoEngine
  port: number
  onLog: Logger
}) => GatewayLifecycle

const TENANT_RETRY_INITIAL_MS = 30_000
const TENANT_RETRY_MAX_MS = 5 * 60_000

export type ThreadEntry = {
  tenantKey: string
  threadKey: string
  threadId: string
}

export type EngineProjectSummary = {
  id: string
  name: string
  path: string
  enabled: boolean
  tenantRunning: boolean
}

export class LeucoEngine {
  private tenants: LeucoTenant[]
  private readonly projectStore: LeucoProjectStore
  private readonly buildTenant: (project: Project) => LeucoTenant
  private readonly port: number | undefined
  private readonly log: Logger
  private readonly bus: LeucoEventBus
  private readonly buildGateway: GatewayBuilder
  private readonly tenantSignatures: Map<string, string>
  private readonly tenantRetries = new Map<string, TenantRetryState>()
  private gateway: GatewayLifecycle | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimerAt: number | null = null
  private startPromise: Promise<void> | null = null
  private stopPromise: Promise<void> | null = null
  private reconcileQueue: Promise<void> = Promise.resolve()
  private startInProgress = false
  private stopped = false

  constructor(props: LeucoEngineProps) {
    this.tenants = props.tenants
    this.projectStore = props.projectStore
    this.buildTenant = props.buildTenant
    this.port = props.port
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.bus = props.bus ?? new LeucoEventBus()
    this.buildGateway =
      props.buildGateway ?? ((gatewayProps) => new LeucoGatewayServer(gatewayProps))
    this.tenantSignatures = this.loadInitialTenantSignatures()
  }

  start(): Promise<void> {
    if (this.startPromise !== null) return this.startPromise

    const startPromise = this.runStart()
    this.startPromise = startPromise
    return startPromise
  }

  private async runStart(): Promise<void> {
    this.startInProgress = true
    const started: LeucoTenant[] = []
    try {
      this.startGateway()
      for (const tenant of this.tenants) {
        if (this.stopped) break
        if (await this.tryStartInitialTenant(tenant)) {
          if (this.stopped) {
            await this.safeStop(tenant)
            break
          }
          started.push(tenant)
        }
      }
      this.tenants = started
    } finally {
      this.startInProgress = false
    }

    if (this.stopped) return
    this.scheduleNextRetry()
    const summary = this.tenants.map((t) => t.key).join(", ") || "(no tenants)"
    const retrying = Array.from(this.tenantRetries.values())
      .map((retry) => retry.projectName)
      .join(", ")
    const suffix = retrying.length > 0 ? `; retrying: ${retrying}` : ""
    this.log(`[leuco] ready — tenants: ${summary}${suffix}`)
  }

  stop(): Promise<void> {
    if (this.stopPromise !== null) return this.stopPromise

    this.stopped = true
    this.cancelRetryTimer()
    this.log("[leuco] shutting down")

    const stopPromise = this.runStop()
    this.stopPromise = stopPromise
    return stopPromise
  }

  private async runStop(): Promise<void> {
    // A signal can arrive while a tenant is still starting. Wait for that
    // attempt to settle; runStart observes `stopped`, skips later tenants, and
    // immediately drains a tenant that finished after shutdown began.
    await this.startPromise?.catch(() => undefined)

    // Drain any in-flight reconcile so it cannot mutate `this.tenants` after
    // we null it out. Errors inside reconcile are already swallowed at the
    // `reconcileQueue` site, so awaiting it is safe and cannot reject.
    await this.reconcileQueue

    await this.safeStopTenants(this.tenants)
    this.tenants = []
    this.tenantSignatures.clear()
    this.tenantRetries.clear()

    await this.safeStopGateway("shutdown")
    this.bus.stop()
  }

  async reconcile(): Promise<void> {
    if (this.stopped) return
    const result = this.reconcileQueue.then(async () => {
      await this.startPromise
      if (this.stopped) return
      return this.runReconcile()
    })
    this.reconcileQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async runReconcile(): Promise<void> {
    let projects: Project[]
    try {
      projects = this.getRunnableProjects(true)
    } catch (err) {
      const reason = errorMessage(err)
      this.log(`[leuco] reconcile: failed to load projects: ${reason}`)
      this.bus.emit({ ts: Date.now(), type: "engine.reconcile.failed", reason })
      this.deferDueRetries()
      this.scheduleNextRetry()
      return
    }

    const targetById = new Map<string, { project: Project; tenantSignature: string }>()
    for (const project of projects) {
      if (!project.enabled) continue
      const tenantSignature = tenantConfigSignature(project)
      targetById.set(project.id, { project, tenantSignature })
    }
    this.clearRetriesOutsideTargets(targetById)

    const removed: string[] = []
    const added: string[] = []
    const keep: LeucoTenant[] = []

    for (const tenant of this.tenants) {
      const target = targetById.get(tenant.projectId)
      if (target === undefined) {
        this.log(`[leuco] reconcile: stopping ${tenant.key}`)
        await this.safeStop(tenant)
        this.tenantSignatures.delete(tenant.projectId)
        this.tenantRetries.delete(tenant.projectId)
        removed.push(tenant.key)
        continue
      }

      const currentSignature = this.tenantSignatures.get(tenant.projectId)
      const nameChanged = tenant.key !== target.project.name
      if (
        !nameChanged &&
        (currentSignature === target.tenantSignature ||
          (currentSignature === undefined && !this.tenantNeedsRebuild(tenant, target)))
      ) {
        this.tenantRetries.delete(tenant.projectId)
        keep.push(tenant)
        continue
      }

      const reason = nameChanged
        ? `renamed ${tenant.key} → ${target.project.name}`
        : "effective tenant configuration changed"
      this.log(`[leuco] reconcile: ${reason}; rebuilding`)
      await this.safeStop(tenant)
      this.tenantSignatures.delete(tenant.projectId)

      const rebuilt = await this.tryBuildAndStart(target.project, target.tenantSignature)
      if (rebuilt === null) {
        removed.push(tenant.key)
        continue
      }
      keep.push(rebuilt)
      this.tenantSignatures.set(target.project.id, target.tenantSignature)
      added.push(`${target.project.name} (rebuilt)`)
    }
    this.tenants = keep

    const runningIds = new Set(this.tenants.map((t) => t.projectId))
    for (const entry of targetById) {
      const id = entry[0]
      const target = entry[1]
      if (runningIds.has(id)) continue

      const retry = this.tenantRetries.get(id)
      if (retry !== undefined) {
        if (retry.signature !== target.tenantSignature) {
          this.tenantRetries.delete(id)
        } else if (retry.retryAt > Date.now()) {
          continue
        }
      }

      this.log(`[leuco] reconcile: starting ${target.project.name}`)
      const started = await this.tryBuildAndStart(target.project, target.tenantSignature)
      if (started === null) continue

      this.tenants.push(started)
      this.tenantSignatures.set(target.project.id, target.tenantSignature)
      added.push(target.project.name)
    }

    this.bus.emit({ ts: Date.now(), type: "engine.reconcile", added, removed })
    this.scheduleNextRetry()
  }

  private tenantNeedsRebuild(
    tenant: LeucoTenant,
    target: { project: Project; tenantSignature: string },
  ): boolean {
    if (tenant.key !== target.project.name) return true

    // Tenants built by runtime.ts carry the full config fingerprint, so token
    // / path / prompt changes are picked up. Test-built tenants without one
    // fall back to comparing the enabled-channel-name set.
    if (tenant.configSignature !== null) {
      return tenant.configSignature !== target.tenantSignature
    }

    const currentSig = tenant.listPlugins().slice().sort().join(",")
    return currentSig !== enabledChannelSignature(target.project)
  }

  private async tryStartInitialTenant(tenant: LeucoTenant): Promise<boolean> {
    try {
      await tenant.start()
      this.tenantRetries.delete(tenant.projectId)
      return true
    } catch (err) {
      const signature =
        this.tenantSignatures.get(tenant.projectId) ??
        this.getCurrentProjectSignature(tenant.projectId)
      this.tenantSignatures.delete(tenant.projectId)
      await this.safeStop(tenant)
      this.recordTenantFailure({
        projectId: tenant.projectId,
        projectName: tenant.key,
        signature,
        phase: "start",
        error: err,
      })
      return false
    }
  }

  private async tryBuildAndStart(project: Project, signature: string): Promise<LeucoTenant | null> {
    let built: LeucoTenant
    try {
      built = this.buildTenant(project)
    } catch (err) {
      this.recordTenantFailure({
        projectId: project.id,
        projectName: project.name,
        signature,
        phase: "build",
        error: err,
      })
      return null
    }
    try {
      await built.start()
      this.tenantRetries.delete(project.id)
      return built
    } catch (err) {
      await this.safeStop(built)
      this.recordTenantFailure({
        projectId: project.id,
        projectName: project.name,
        signature,
        phase: "start",
        error: err,
      })
      return null
    }
  }

  private async safeStop(tenant: LeucoTenant): Promise<void> {
    try {
      await tenant.stop()
    } catch (err) {
      this.log(`[leuco] reconcile: ${tenant.key}: stop failed: ${errorMessage(err)}`)
    }
  }

  private async safeStopTenants(tenants: ReadonlyArray<LeucoTenant>): Promise<void> {
    await Promise.all(tenants.map((tenant) => this.safeStop(tenant)))
  }

  private recordTenantFailure(input: {
    projectId: string
    projectName: string
    signature: string | null
    phase: "build" | "start"
    error: unknown
  }): void {
    const previous = this.tenantRetries.get(input.projectId)
    const continuesSameFailure = previous !== undefined && previous.signature === input.signature
    const attempt = continuesSameFailure ? previous.attempt + 1 : 1
    const now = Date.now()
    const retryDelay = retryDelayMs(attempt)
    const retryAt = now + retryDelay
    const reason = `tenant ${input.projectName} ${input.phase} failed: ${errorMessage(input.error)}`

    this.tenantRetries.set(input.projectId, {
      attempt,
      projectName: input.projectName,
      signature: input.signature,
      retryAt,
    })
    this.log(`[leuco] ${reason}; retry ${attempt} in ${Math.ceil(retryDelay / 1000)}s`)
    this.bus.emit({
      ts: now,
      type: "engine.reconcile.failed",
      reason,
      project: input.projectName,
      attempt,
      retryAt,
    })
    this.scheduleNextRetry()
  }

  private clearRetriesOutsideTargets(
    targets: ReadonlyMap<string, { project: Project; tenantSignature: string }>,
  ): void {
    for (const projectId of this.tenantRetries.keys()) {
      if (!targets.has(projectId)) {
        this.tenantRetries.delete(projectId)
      }
    }
  }

  private deferDueRetries(): void {
    const now = Date.now()
    for (const entry of this.tenantRetries) {
      const projectId = entry[0]
      const retry = entry[1]
      if (retry.retryAt > now) continue

      const attempt = retry.attempt + 1
      this.tenantRetries.set(projectId, {
        ...retry,
        attempt,
        retryAt: now + retryDelayMs(attempt),
      })
    }
  }

  private scheduleNextRetry(): void {
    if (this.stopped || this.startInProgress) return

    let retryAt: number | null = null
    for (const retry of this.tenantRetries.values()) {
      retryAt = retryAt === null ? retry.retryAt : Math.min(retryAt, retry.retryAt)
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
          this.bus.emit({ ts: Date.now(), type: "engine.reconcile.failed", reason })
          this.deferDueRetries()
          this.scheduleNextRetry()
        })
      },
      Math.max(0, retryAt - Date.now()),
    )
    this.retryTimer.unref()
  }

  private cancelRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
    }
    this.retryTimer = null
    this.retryTimerAt = null
  }

  private startGateway(): void {
    if (this.port === undefined) return

    const gateway = this.buildGateway({
      engine: this,
      port: this.port,
      onLog: this.log,
    })
    gateway.start()
    this.gateway = gateway
  }

  private async safeStopGateway(context: string): Promise<void> {
    const gateway = this.gateway
    if (gateway === null) return

    this.gateway = null
    try {
      await gateway.stop()
    } catch (err) {
      this.log(`[leuco] ${context}: gateway stop failed: ${errorMessage(err)}`)
    }
  }

  private loadInitialTenantSignatures(): Map<string, string> {
    const signatures = new Map<string, string>()
    for (const tenant of this.tenants) {
      if (tenant.configSignature !== null) {
        signatures.set(tenant.projectId, tenant.configSignature)
      }
    }
    return signatures
  }

  private getCurrentProjectSignature(projectId: string): string | null {
    try {
      const project = this.getRunnableProjects(false).find(
        (candidate) => candidate.id === projectId,
      )
      return project === undefined ? null : tenantConfigSignature(project)
    } catch {
      return null
    }
  }

  getCwd(): string {
    return this.tenants[0]?.projectPath ?? ""
  }

  listProjects(): EngineProjectSummary[] {
    let projects: Project[]
    try {
      projects = this.getRunnableProjects(true)
    } catch (err) {
      this.log(`[leuco] listProjects: ${errorMessage(err)}`)
      return []
    }

    const runningIds = new Set(this.tenants.map((t) => t.projectId))
    return projects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      enabled: project.enabled,
      tenantRunning: runningIds.has(project.id),
    }))
  }

  private getRunnableProjects(shouldReportIssues: boolean): Project[] {
    if (typeof this.projectStore.listRunnable !== "function") {
      return this.projectStore.list()
    }

    const runnable = this.projectStore.listRunnable()
    if (shouldReportIssues) {
      for (const issue of runnable.issues) {
        const reason = `project ${issue.project} is invalid and was skipped: ${issue.error}`
        this.log(`[leuco] ${reason}`)
        this.bus.emit({
          ts: Date.now(),
          type: "engine.reconcile.failed",
          reason,
          project: issue.project,
        })
      }
    }
    return runnable.projects
  }

  isCodexRunning(): boolean {
    return this.tenants.some((t) => t.isCodexRunning())
  }

  listPlugins(): string[] {
    const names: string[] = []
    for (const tenant of this.tenants) {
      for (const name of tenant.listPlugins()) {
        names.push(`${tenant.key}:${name}`)
      }
    }
    return names
  }

  listThreads(): ThreadEntry[] {
    const out: ThreadEntry[] = []
    for (const tenant of this.tenants) {
      for (const thread of tenant.listThreads()) {
        out.push({
          tenantKey: tenant.key,
          threadKey: thread.threadKey,
          threadId: thread.threadId,
        })
      }
    }
    return out
  }

  clearThread(threadKey: string): boolean {
    for (const tenant of this.tenants) {
      if (tenant.clearThread(threadKey)) return true
    }
    return false
  }
}

const retryDelayMs = (attempt: number): number => {
  const exponent = Math.min(Math.max(attempt - 1, 0), 4)
  return Math.min(TENANT_RETRY_INITIAL_MS * 2 ** exponent, TENANT_RETRY_MAX_MS)
}

const enabledChannelSignature = (project: Project): string => {
  return project.channels
    .filter((channel) => channel.enabled)
    .map((channel) => channel.name)
    .slice()
    .sort()
    .join(",")
}
