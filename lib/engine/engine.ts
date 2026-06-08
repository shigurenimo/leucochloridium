import type { Agent, Project } from "@/config/config-schema"
import type { LeucoTenant } from "@/engine/tenant"
import { errorMessage } from "@/error-message"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoGatewayServer } from "@/gateway/gateway-server"
import type { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  tenants: LeucoTenant[]
  projectStore: LeucoProjectStore
  buildTenant: (project: Project, agent: Agent) => LeucoTenant
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
  private readonly buildTenant: (project: Project, agent: Agent) => LeucoTenant
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
    // Track which tenants have started so we can roll back if a later one
    // throws. Without this, a partial start leaves codex children and Slack
    // sockets running with no `LeucoRuntime` reference to stop them.
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
        // Gateway bind failed (e.g. EADDRINUSE). Stop the tenants we already
        // started so the process doesn't end up with codex children but no
        // MCP endpoint to reach them.
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
      // Drain in-flight MCP requests before tearing down tenants — otherwise
      // a codex child's tool call mid-flight would see ECONNRESET when the
      // tenant disappears under it.
      await this.gateway.stop()
      this.gateway = null
    }

    for (const tenant of this.tenants) {
      await this.safeStop(tenant)
    }
    this.tenants = []

    // Flush the event log so any final tenant.stopped / log events land on
    // disk before the process exits.
    await this.bus.stop()
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
      // Emit a structured event so consumers (gateway SSE, `leuco logs -f`)
      // can see that the SIGHUP / config edit did not take effect, instead
      // of silently dropping the reload.
      this.bus.emit({ ts: Date.now(), type: "engine.reconcile.failed", reason })
      return
    }

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
        await this.safeStop(tenant)
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
      await this.safeStop(tenant)

      const rebuilt = await this.tryBuildAndStart(target.project, target.agent, tenant.key)
      if (rebuilt === null) {
        removed.push(tenant.key)
        continue
      }
      keep.push(rebuilt)
      added.push(`${tenant.key} (rebuilt)`)
    }
    this.tenants = keep

    const runningKeys = new Set(this.tenants.map((t) => t.key))
    for (const entry of targetByKey) {
      const key = entry[0]
      const target = entry[1]
      if (runningKeys.has(key)) continue

      this.log(`[leuco] reconcile: starting ${key}`)
      const started = await this.tryBuildAndStart(target.project, target.agent, key)
      if (started === null) continue

      this.tenants.push(started)
      added.push(key)
    }

    this.bus.emit({ ts: Date.now(), type: "engine.reconcile", added, removed })
  }

  /**
   * Build a tenant and start it. Failures (build throw or start throw) are
   * logged with the tenant key and the function returns `null` so the
   * surrounding reconcile loop can continue with the next tenant instead of
   * aborting the pass mid-way and leaving `this.tenants` mismatched against
   * `targetByKey`.
   */
  private async tryBuildAndStart(
    project: Project,
    agent: Agent,
    keyForLog: string,
  ): Promise<LeucoTenant | null> {
    let built: LeucoTenant
    try {
      built = this.buildTenant(project, agent)
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
    // Backwards-compat shim for the gateway. With multi-project the engine
    // doesn't have a single cwd; return the first tenant's project path or "".
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
