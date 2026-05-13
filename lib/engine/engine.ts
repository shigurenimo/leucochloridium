import type { Agent, Project } from "@/config/config-schema"
import type { LeucoTenant } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoGatewayServer } from "@/gateway/gateway-server"
import type { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  tenants: LeucoTenant[]
  projectStore: LeucoProjectStore
  buildTenant: (project: Project, agent: Agent) => LeucoTenant | Error
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
  agents: { name: string; enabled: boolean; tenantRunning: boolean }[]
}

/**
 * Top-level orchestrator: starts/stops every `LeucoTenant` (one per enabled
 * (project, agent) pair across all registered projects), exposes aggregate
 * status to the optional HTTP gateway, and reconciles its tenant set against
 * the on-disk config when `reconcile()` is called (e.g. via SIGHUP).
 */
export class LeucoEngine {
  private tenants: LeucoTenant[]
  private readonly projectStore: LeucoProjectStore
  private readonly buildTenant: (project: Project, agent: Agent) => LeucoTenant | Error
  private readonly port: number | undefined
  private readonly log: Logger
  private readonly bus: LeucoEventBus
  private readonly mcpToken: string | null
  private gateway: LeucoGatewayServer | null = null
  // Serialization tail for reconcile(): every incoming call chains onto this
  // promise so two SIGHUPs in quick succession can't interleave start/stop on
  // `this.tenants` and accidentally double-start the same tenant.
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
    for (const tenant of this.tenants) {
      await tenant.start()
    }

    if (this.port !== undefined) {
      this.gateway = new LeucoGatewayServer({
        engine: this,
        port: this.port,
        onLog: this.log,
        mcpToken: this.mcpToken,
      })
      this.gateway.start()
    }

    const summary = this.tenants.map((t) => t.key).join(", ") || "(no tenants)"
    this.log(`[leuco] ready — tenants: ${summary}`)
  }

  async stop(): Promise<void> {
    this.log("[leuco] shutting down")

    if (this.gateway) {
      this.gateway.stop()
      this.gateway = null
    }

    for (const tenant of this.tenants) {
      await tenant.stop()
    }
    this.tenants = []
  }

  /**
   * Diff the engine's running tenants against the latest on-disk config and:
   *  - stop any tenant whose (project, agent) is gone or disabled
   *  - start any tenant whose (project, agent) is newly enabled
   * Channel-level changes inside a still-running tenant currently require a
   * full restart; reconcile() does not yet propagate them.
   *
   * Calls are serialized: a second invocation while a reconcile is in flight
   * waits for it to finish before its own pass starts, so each pass observes
   * a fully-settled `this.tenants`.
   */
  async reconcile(): Promise<void | Error> {
    const result = this.reconcileQueue.then(() => this.runReconcile())
    this.reconcileQueue = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async runReconcile(): Promise<void | Error> {
    const projects = this.projectStore.list()
    if (projects instanceof Error) return projects

    const targetByKey = new Map<string, { project: Project; agent: Agent; pluginSig: string }>()
    for (const project of projects) {
      for (const agent of project.agents) {
        if (!agent.enabled) continue
        const sig = enabledChannelSignature(agent)
        targetByKey.set(`${project.name}:${agent.name}`, { project, agent, pluginSig: sig })
      }
    }

    const removed: string[] = []
    const added: string[] = []
    const keep: LeucoTenant[] = []

    for (const tenant of this.tenants) {
      const target = targetByKey.get(tenant.key)
      if (target === undefined) {
        this.log(`[leuco] reconcile: stopping ${tenant.key}`)
        await tenant.stop()
        removed.push(tenant.key)
        continue
      }

      const currentSig = tenant.listPlugins().slice().sort().join(",")
      if (currentSig === target.pluginSig) {
        keep.push(tenant)
        continue
      }

      this.log(
        `[leuco] reconcile: channel set changed for ${tenant.key} (was [${currentSig}] now [${target.pluginSig}]); rebuilding`,
      )
      await tenant.stop()
      const rebuilt = this.buildTenant(target.project, target.agent)
      if (rebuilt instanceof Error) {
        this.log(`[leuco] reconcile: ${tenant.key}: ${rebuilt.message}`)
        removed.push(tenant.key)
        continue
      }
      await rebuilt.start()
      keep.push(rebuilt)
      added.push(`${tenant.key} (rebuilt)`)
    }
    this.tenants = keep

    const runningKeys = new Set(this.tenants.map((t) => t.key))
    for (const entry of targetByKey) {
      const key = entry[0]
      const target = entry[1]
      if (runningKeys.has(key)) continue

      const tenant = this.buildTenant(target.project, target.agent)
      if (tenant instanceof Error) {
        this.log(`[leuco] reconcile: ${key}: ${tenant.message}`)
        continue
      }
      this.log(`[leuco] reconcile: starting ${key}`)
      await tenant.start()
      this.tenants.push(tenant)
      added.push(key)
    }

    this.bus.emit({ ts: Date.now(), type: "engine.reconcile", added, removed })
  }

  getCwd(): string {
    // Backwards-compat shim for the gateway. With multi-project the engine
    // doesn't have a single cwd; return the first tenant's project path or "".
    return this.tenants[0]?.projectPath ?? ""
  }

  listProjects(): EngineProjectSummary[] {
    const projects = this.projectStore.list()
    if (projects instanceof Error) return []

    const runningKeys = new Set(this.tenants.map((t) => t.key))
    return projects.map((project) => ({
      name: project.name,
      path: project.path,
      agents: project.agents.map((agent) => ({
        name: agent.name,
        enabled: agent.enabled,
        tenantRunning: runningKeys.has(`${project.name}:${agent.name}`),
      })),
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

const enabledChannelSignature = (agent: Agent): string => {
  return agent.channels
    .filter((c) => c.enabled)
    .map((c) => c.name)
    .slice()
    .sort()
    .join(",")
}
