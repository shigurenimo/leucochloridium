import type { Project } from "@/config/config-schema"
import type { LeucoTenant } from "@/engine/tenant"
import { errorMessage } from "@/error-message"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoGatewayServer } from "@/gateway/gateway-server"
import type { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  tenants: LeucoTenant[]
  projectStore: LeucoProjectStore
  buildTenant: (project: Project) => LeucoTenant
  port?: number
  onLog?: (line: string) => void
  bus?: LeucoEventBus
  mcpToken?: string | null
}

type Logger = (line: string) => void

export type ThreadEntry = {
  tenantKey: string
  threadKey: string
  threadId: string
}

export type EngineProjectSummary = {
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
  private readonly mcpToken: string | null
  private gateway: LeucoGatewayServer | null = null
  private reconcileQueue: Promise<void> = Promise.resolve()

  constructor(props: Props) {
    this.tenants = props.tenants
    this.projectStore = props.projectStore
    this.buildTenant = props.buildTenant
    this.port = props.port
    this.log = props.onLog ?? ((line) => process.stdout.write(`${line}\n`))
    this.bus = props.bus ?? new LeucoEventBus()
    this.mcpToken = props.mcpToken ?? null
  }

  async start(): Promise<void> {
    const started: LeucoTenant[] = []
    try {
      for (const tenant of this.tenants) {
        await tenant.start()
        started.push(tenant)
      }
    } catch (error) {
      for (const tenant of started.reverse()) {
        await tenant.stop().catch((err: unknown) => {
          this.log(`[leuco] start rollback: ${tenant.key}: ${errorMessage(err)}`)
        })
      }
      this.tenants = []
      throw error
    }

    if (this.port !== undefined) {
      this.gateway = new LeucoGatewayServer({
        engine: this,
        port: this.port,
        onLog: this.log,
        mcpToken: this.mcpToken,
      })
      try {
        this.gateway.start()
      } catch (error) {
        for (const tenant of this.tenants.slice().reverse()) {
          await tenant.stop().catch(() => undefined)
        }
        this.tenants = []
        this.gateway = null
        throw error
      }
    }

    const summary = this.tenants.map((t) => t.key).join(", ") || "(no tenants)"
    this.log(`[leuco] ready — tenants: ${summary}`)
  }

  async stop(): Promise<void> {
    this.log("[leuco] shutting down")

    if (this.gateway) {
      await this.gateway.stop()
      this.gateway = null
    }

    for (const tenant of this.tenants) {
      await this.safeStop(tenant)
    }
    this.tenants = []

    this.bus.stop()
  }

  async reconcile(): Promise<void> {
    const result = this.reconcileQueue.then(() => this.runReconcile())
    this.reconcileQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async runReconcile(): Promise<void> {
    let projects: Project[]
    try {
      projects = this.projectStore.list()
    } catch (err) {
      const reason = errorMessage(err)
      this.log(`[leuco] reconcile: failed to load projects: ${reason}`)
      this.bus.emit({ ts: Date.now(), type: "engine.reconcile.failed", reason })
      return
    }

    const targetById = new Map<string, { project: Project; pluginSig: string }>()
    for (const project of projects) {
      if (!project.enabled) continue
      const sig = enabledChannelSignature(project)
      targetById.set(project.id, { project, pluginSig: sig })
    }

    const removed: string[] = []
    const added: string[] = []
    const keep: LeucoTenant[] = []

    for (const tenant of this.tenants) {
      const target = targetById.get(tenant.projectId)
      if (target === undefined) {
        this.log(`[leuco] reconcile: stopping ${tenant.key}`)
        await this.safeStop(tenant)
        removed.push(tenant.key)
        continue
      }

      const currentSig = tenant.listPlugins().slice().sort().join(",")
      const nameChanged = tenant.key !== target.project.name
      if (currentSig === target.pluginSig && !nameChanged) {
        keep.push(tenant)
        continue
      }

      const reason = nameChanged
        ? `renamed ${tenant.key} → ${target.project.name}`
        : `channel set changed (was [${currentSig}] now [${target.pluginSig}])`
      this.log(`[leuco] reconcile: ${reason}; rebuilding`)
      await this.safeStop(tenant)

      const rebuilt = await this.tryBuildAndStart(target.project, target.project.name)
      if (rebuilt === null) {
        removed.push(tenant.key)
        continue
      }
      keep.push(rebuilt)
      added.push(`${target.project.name} (rebuilt)`)
    }
    this.tenants = keep

    const runningIds = new Set(this.tenants.map((t) => t.projectId))
    for (const entry of targetById) {
      const id = entry[0]
      const target = entry[1]
      if (runningIds.has(id)) continue

      this.log(`[leuco] reconcile: starting ${target.project.name}`)
      const started = await this.tryBuildAndStart(target.project, target.project.name)
      if (started === null) continue

      this.tenants.push(started)
      added.push(target.project.name)
    }

    this.bus.emit({ ts: Date.now(), type: "engine.reconcile", added, removed })
  }

  private async tryBuildAndStart(project: Project, keyForLog: string): Promise<LeucoTenant | null> {
    let built: LeucoTenant
    try {
      built = this.buildTenant(project)
    } catch (err) {
      this.log(`[leuco] reconcile: ${keyForLog}: build failed: ${errorMessage(err)}`)
      return null
    }
    try {
      await built.start()
      return built
    } catch (err) {
      this.log(`[leuco] reconcile: ${keyForLog}: start failed: ${errorMessage(err)}`)
      await built.stop().catch(() => undefined)
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

  getCwd(): string {
    return this.tenants[0]?.projectPath ?? ""
  }

  listProjects(): EngineProjectSummary[] {
    let projects: Project[]
    try {
      projects = this.projectStore.list()
    } catch (err) {
      this.log(`[leuco] listProjects: ${errorMessage(err)}`)
      return []
    }

    const runningIds = new Set(this.tenants.map((t) => t.projectId))
    return projects.map((project) => ({
      name: project.name,
      path: project.path,
      enabled: project.enabled,
      tenantRunning: runningIds.has(project.id),
    }))
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

const enabledChannelSignature = (project: Project): string => {
  return project.channels
    .filter((c) => c.enabled)
    .map((c) => c.name)
    .slice()
    .sort()
    .join(",")
}
