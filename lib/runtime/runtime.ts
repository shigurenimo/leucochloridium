import { randomBytes } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import pkg from "../../package.json" with { type: "json" }
import { LeucoChannelHost } from "@/channels/channel-host"
import type { Agent, Project } from "@/config/config-schema"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { LeucoEngine } from "@/engine/engine"
import { LeucoPromptPresets } from "@/engine/prompt-presets"
import { LeucoTenant, type TenantAgentSpec } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

type Logger = (line: string) => void

type Props = {
  env: NodeJS.ProcessEnv
  home?: string
  port?: number
  codexBin?: string
  onLog?: Logger
}

const LEUCO_MCP_TOKEN_ENV = "LEUCO_MCP_TOKEN"

/**
 * Composition root: scans every registered project under
 * `~/.leuco/projects/<name>/settings.json`, builds one `LeucoTenant` per
 * enabled (project, agent) pair, and wires the engine. Disabled agents and
 * channels are skipped at build time; `engine.reconcile()` re-applies the
 * same logic when config changes mid-flight.
 */
export class LeucoRuntime {
  private constructor(
    private readonly props: {
      projectStore: LeucoProjectStore
      engine: LeucoEngine
      paths: LeucoPaths
      env: NodeJS.ProcessEnv
      codexBin: string | undefined
      onLog: Logger
    },
  ) {
    Object.freeze(this)
  }

  static build(buildProps: Props): LeucoRuntime | Error {
    const baseLog = buildProps.onLog ?? ((line: string) => process.stdout.write(`${line}\n`))
    const paths = new LeucoPaths({ home: buildProps.home })
    const bus = new LeucoEventBus({ eventLogPath: paths.daemonEventLogPath() })

    // Wrap onLog so every text log line also lands in events.jsonl as a `log`
    // event. Components keep using onLog as before.
    const onLog: Logger = (line) => {
      baseLog(line)
      bus.emit({ ts: Date.now(), type: "log", level: "info", line })
    }

    const projectStore = new LeucoProjectStore({ paths })

    const projects = projectStore.list()
    if (projects instanceof Error) return projects

    // One MCP bearer token per daemon process. Codex children inherit it via
    // the LEUCO_MCP_TOKEN env var (referenced from each tenant's CODEX_HOME
    // config.toml as `bearer_token_env_var`).
    const mcpToken = buildProps.port !== undefined ? randomBytes(32).toString("hex") : null
    const mcpPort = buildProps.port

    const tenants: LeucoTenant[] = []
    for (const project of projects) {
      for (const agent of project.agents) {
        if (!agent.enabled) continue
        const tenant = buildTenant({
          project,
          agent,
          paths,
          env: buildProps.env,
          codexBin: buildProps.codexBin,
          onLog,
          bus,
          projectStore,
          mcpToken,
          mcpPort,
        })
        if (tenant instanceof Error) return tenant
        tenants.push(tenant)
      }
    }

    const buildTenantFn = (project: Project, agent: Agent): LeucoTenant | Error =>
      buildTenant({
        project,
        agent,
        paths,
        env: buildProps.env,
        codexBin: buildProps.codexBin,
        onLog,
        bus,
        projectStore,
        mcpToken,
        mcpPort,
      })

    const engine = new LeucoEngine({
      tenants,
      port: buildProps.port,
      onLog,
      projectStore,
      buildTenant: buildTenantFn,
      bus,
      mcpToken,
    })

    return new LeucoRuntime({
      projectStore,
      engine,
      paths,
      env: buildProps.env,
      codexBin: buildProps.codexBin,
      onLog,
    })
  }

  getEngine(): LeucoEngine {
    return this.props.engine
  }

  getProjectStore(): LeucoProjectStore {
    return this.props.projectStore
  }

  async start(): Promise<void | Error> {
    try {
      await this.props.engine.start()
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  async stop(): Promise<void> {
    await this.props.engine.stop()
  }

  /** Re-read every settings.json and reconcile the engine's tenant set. */
  async reload(): Promise<void | Error> {
    return this.props.engine.reconcile()
  }
}

type BuildTenantProps = {
  project: Project
  agent: Agent
  paths: LeucoPaths
  env: NodeJS.ProcessEnv
  codexBin: string | undefined
  onLog: Logger
  bus: LeucoEventBus
  projectStore: LeucoProjectStore
  mcpToken: string | null
  mcpPort: number | undefined
}

const buildTenant = (props: BuildTenantProps): LeucoTenant | Error => {
  const enabledChannels = props.agent.channels.filter((ch) => ch.enabled)
  const filteredAgent: Agent = { ...props.agent, channels: enabledChannels }

  const plugins = LeucoChannelHost.buildForAgent({
    projectName: props.project.name,
    agent: filteredAgent,
    projectStore: props.projectStore,
  })
  if (plugins instanceof Error) return plugins

  const tomlStore = new LeucoCodexAgentStore({ cwd: props.project.path })
  const spec = tomlStore.read({ scope: "project", name: props.agent.name })
  if (spec instanceof Error) {
    return new Error(
      `${spec.message} — run \`leuco projects ${props.project.name} agents add ${props.agent.name}\` to recreate it.`,
    )
  }

  const codexHome = ensureCodexHome(props.paths, props.project.name, props.agent.name)
  ensureTenantConfigToml(codexHome, {
    projectPath: props.project.path,
    projectName: props.project.name,
    agentName: props.agent.name,
    mcpEndpoint:
      props.mcpToken !== null && props.mcpPort !== undefined
        ? { url: `http://127.0.0.1:${props.mcpPort}/mcp/${props.project.name}/${props.agent.name}` }
        : null,
  })
  ensureAuthSymlink(codexHome)

  const childEnv: NodeJS.ProcessEnv = { ...props.env, CODEX_HOME: codexHome }
  if (props.mcpToken !== null) {
    childEnv[LEUCO_MCP_TOKEN_ENV] = props.mcpToken
  }

  const codex = new LeucoCodexClient({
    bin: props.codexBin,
    cwd: props.project.path,
    env: childEnv,
    onLog: props.onLog,
    clientVersion: pkg.version,
    onAnyNotification: (method, params) => {
      props.bus.emit({
        ts: Date.now(),
        type: "codex.notification",
        project: props.project.name,
        agent: props.agent.name,
        method,
        params,
      })
    },
  })

  const agentSpec: TenantAgentSpec = {
    developerInstructions:
      spec.developerInstructions.length > 0 ? spec.developerInstructions : undefined,
    model: spec.model ?? undefined,
  }

  const listSubagents = () =>
    tomlStore
      .list("project")
      .filter((entry) => entry.name !== props.agent.name)
      .map((entry) => ({ name: entry.name, path: entry.path }))

  const presets = LeucoPromptPresets.resolveAll(props.agent.prompts)

  return new LeucoTenant({
    projectName: props.project.name,
    projectPath: props.project.path,
    agentName: props.agent.name,
    agentSpec,
    codex,
    plugins,
    onLog: props.onLog,
    bus: props.bus,
    initialCodexThreadId: props.agent.codexThreadId,
    projectStore: props.projectStore,
    useCommonInstructions: props.agent.useCommonInstructions,
    listSubagents,
    presets,
  })
}

const ensureCodexHome = (paths: LeucoPaths, projectName: string, agentName: string): string => {
  const dir = paths.agentHome(projectName, agentName)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write the tenant's CODEX_HOME `config.toml`. Four things go in here:
 *   1. `approval_policy = "never"` + `sandbox_mode = "workspace-write"` so the
 *      daemon (which has no terminal to answer prompts) never stalls waiting
 *      for human approval; codex returns execution failures straight to the
 *      model instead.
 *   2. project trust (so codex loads the repo's `.codex/`)
 *   3. an `mcp_servers.leuco` entry pointing at the daemon's streamable HTTP
 *      route at `/mcp/<project>/<agent>` (with bearer auth via env var). When
 *      the gateway port isn't available, falls back to the legacy stdio spawn
 *      so single-process callers still work.
 *   4. `approval_mode = "approve"` overrides on every leuco-managed tool — kept
 *      even with the global `never` policy as belt-and-suspenders in case the
 *      global default changes in a future codex release.
 */
const ensureTenantConfigToml = (
  codexHome: string,
  tenant: {
    projectPath: string
    projectName: string
    agentName: string
    mcpEndpoint: { url: string } | null
  },
): void => {
  const path = join(codexHome, "config.toml")
  const autoApproveTools = ["slack_call", "schedule_create", "schedule_list", "schedule_delete"]
  const lines = [
    `approval_policy = "never"`,
    `sandbox_mode = "workspace-write"`,
    "",
    `[projects.${tomlKeyString(tenant.projectPath)}]`,
    `trust_level = "trusted"`,
    "",
    `[mcp_servers.leuco]`,
  ]

  if (tenant.mcpEndpoint !== null) {
    lines.push(
      `url = ${tomlKeyString(tenant.mcpEndpoint.url)}`,
      `bearer_token_env_var = "${LEUCO_MCP_TOKEN_ENV}"`,
      "",
    )
  } else {
    lines.push(
      `command = "leuco"`,
      `args = ["mcp", "--project", ${tomlKeyString(tenant.projectName)}, "--agent", ${tomlKeyString(tenant.agentName)}]`,
      "",
    )
  }

  for (const tool of autoApproveTools) {
    lines.push(`[mcp_servers.leuco.tools.${tool}]`, `approval_mode = "approve"`, "")
  }
  writeFileSync(path, lines.join("\n"))
}

/**
 * Codex authenticates against the credentials in `<CODEX_HOME>/auth.json`.
 * Per-tenant CODEX_HOMEs would otherwise need a separate `codex login` each;
 * symlink the user's default `~/.codex/auth.json` so all tenants share the
 * same login (memories stay isolated, auth stays singular).
 */
const ensureAuthSymlink = (codexHome: string): void => {
  const source = join(homedir(), ".codex", "auth.json")
  if (!existsSync(source)) return

  const target = join(codexHome, "auth.json")
  if (existsSync(target) || isBrokenSymlink(target)) {
    if (currentSymlinkTarget(target) === source) return
    unlinkSync(target)
  }
  symlinkSync(source, target)
}

const isBrokenSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

const currentSymlinkTarget = (path: string): string | null => {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return readlinkSync(path)
  } catch {
    return null
  }
}

const tomlKeyString = (value: string): string => {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
