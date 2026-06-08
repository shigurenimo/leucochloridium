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
import { join } from "node:path"
import pkg from "../../package.json" with { type: "json" }
import { LeucoChannelHost } from "@/channels/channel-host"
import type { Agent, McpServer, Project } from "@/config/config-schema"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { errorMessage } from "@/error-message"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { tomlString } from "@/engine/codex/toml-string"
import { LeucoEngine } from "@/engine/engine"
import { LeucoPromptPresets } from "@/engine/prompt-presets"
import { LeucoTenant, type TenantAgentSpec } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoAgentStateStore } from "@/projects/agent-state-store"
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

  static build(buildProps: Props): LeucoRuntime {
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
    const agentStateStore = new LeucoAgentStateStore({ paths })
    const projects = projectStore.list()

    // One MCP bearer token per daemon process. Codex children inherit it via
    // the LEUCO_MCP_TOKEN env var (referenced from each tenant's CODEX_HOME
    // config.toml as `bearer_token_env_var`).
    const mcpToken = buildProps.port !== undefined ? randomBytes(32).toString("hex") : null
    const mcpPort = buildProps.port

    const tenants: LeucoTenant[] = []
    for (const project of projects) {
      for (const agent of project.agents) {
        if (!agent.enabled) continue
        tenants.push(
          buildTenant({
            project,
            agent,
            paths,
            env: buildProps.env,
            codexBin: buildProps.codexBin,
            onLog,
            bus,
            projectStore,
            agentStateStore,
            mcpToken,
            mcpPort,
          }),
        )
      }
    }

    const buildTenantFn = (project: Project, agent: Agent): LeucoTenant =>
      buildTenant({
        project,
        agent,
        paths,
        env: buildProps.env,
        codexBin: buildProps.codexBin,
        onLog,
        bus,
        projectStore,
        agentStateStore,
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

  async start(): Promise<void> {
    await this.props.engine.start()
  }

  async stop(): Promise<void> {
    await this.props.engine.stop()
  }

  /** Re-read every settings.json and reconcile the engine's tenant set. */
  async reload(): Promise<void> {
    await this.props.engine.reconcile()
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
  agentStateStore: LeucoAgentStateStore
  mcpToken: string | null
  mcpPort: number | undefined
}

const buildTenant = (props: BuildTenantProps): LeucoTenant => {
  const enabledChannels = props.agent.channels.filter((ch) => ch.enabled)
  const filteredAgent: Agent = { ...props.agent, channels: enabledChannels }

  const plugins = LeucoChannelHost.buildForAgent({
    project: { id: props.project.id, name: props.project.name },
    agent: filteredAgent,
    projectStore: props.projectStore,
    agentStateStore: props.agentStateStore,
  })

  const tomlStore = new LeucoCodexAgentStore({ cwd: props.project.path })
  let spec: ReturnType<typeof tomlStore.read>
  try {
    spec = tomlStore.read({ scope: "project", name: props.agent.name })
  } catch (err) {
    throw new Error(
      `${errorMessage(err)} — run \`leuco projects ${props.project.name} agents add ${props.agent.name}\` to recreate it.`,
    )
  }

  const codexHome = ensureCodexHome(props.paths, props.project.id, props.agent.name)
  ensureTenantConfigToml(codexHome, {
    projectPath: props.project.path,
    projectId: props.project.id,
    projectName: props.project.name,
    agentName: props.agent.name,
    mcpEndpoint:
      props.mcpToken !== null && props.mcpPort !== undefined
        ? { url: `http://127.0.0.1:${props.mcpPort}/mcp/${props.project.id}/${props.agent.name}` }
        : null,
    extraMcpServers: props.agent.mcpServers,
  })
  ensureAuthSymlink(codexHome, props.paths.codexAuthPath())

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

  const initialState = props.agentStateStore.load(props.project.id, props.agent.name)

  return new LeucoTenant({
    projectId: props.project.id,
    projectName: props.project.name,
    projectPath: props.project.path,
    agentName: props.agent.name,
    agentSpec,
    codex,
    plugins,
    onLog: props.onLog,
    bus: props.bus,
    initialCodexThreadId: initialState.codexThreadId ?? undefined,
    agentStateStore: props.agentStateStore,
    useCommonInstructions: props.agent.useCommonInstructions,
    listSubagents,
    presets,
  })
}

const ensureCodexHome = (paths: LeucoPaths, projectId: string, agentName: string): string => {
  const dir = paths.agentHome(projectId, agentName)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write the tenant's CODEX_HOME `config.toml`. Four things go in here:
 *   1. `approval_policy = "never"` + `sandbox_mode = "danger-full-access"` so
 *      the daemon never stalls on a prompt it can't answer AND never trips
 *      EPERM in the seatbelt/landlock sandbox. `workspace-write` would be
 *      safer but it blocks outbound network by default on macOS, and the
 *      `sandbox_workspace_write.network_access = true` escape hatch is
 *      silently ignored by seatbelt (codex issue #10390); for a daemon that
 *      needs to push commits, hit external APIs, install deps, etc., full
 *      access is the only configuration that actually unblocks everything.
 *   2. project trust (so codex loads the repo's `.codex/`)
 *   3. an `mcp_servers.leuco` entry pointing at the daemon's streamable HTTP
 *      route at `/mcp/<project>/<agent>` (with bearer auth via env var). When
 *      the gateway port isn't available, falls back to the legacy stdio spawn
 *      so single-process callers still work.
 *   4. `approval_mode = "approve"` overrides on every leuco-managed tool — kept
 *      even with the global `never` policy as belt-and-suspenders in case the
 *      global default changes in a future codex release.
 *   5. any per-agent `mcpServers` from settings.json, each as its own
 *      `[mcp_servers.<key>]` stdio block. The reserved `leuco` key is skipped
 *      so a misconfigured agent can never shadow the built-in server.
 */
const ensureTenantConfigToml = (
  codexHome: string,
  tenant: {
    projectPath: string
    projectId: string
    projectName: string
    agentName: string
    mcpEndpoint: { url: string } | null
    extraMcpServers: Record<string, McpServer>
  },
): void => {
  const path = join(codexHome, "config.toml")
  const autoApproveTools = ["slack_call", "schedule_create", "schedule_list", "schedule_delete"]
  const lines = [
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "",
    `[projects.${tomlString(tenant.projectPath)}]`,
    `trust_level = "trusted"`,
    "",
    `[mcp_servers.leuco]`,
  ]

  if (tenant.mcpEndpoint !== null) {
    lines.push(
      `url = ${tomlString(tenant.mcpEndpoint.url)}`,
      `bearer_token_env_var = "${LEUCO_MCP_TOKEN_ENV}"`,
      "",
    )
  } else {
    lines.push(
      `command = "leuco"`,
      `args = ["mcp", "--project", ${tomlString(tenant.projectName)}, "--agent", ${tomlString(tenant.agentName)}]`,
      "",
    )
  }

  for (const tool of autoApproveTools) {
    lines.push(`[mcp_servers.leuco.tools.${tool}]`, `approval_mode = "approve"`, "")
  }

  for (const [name, server] of Object.entries(tenant.extraMcpServers)) {
    if (name === "leuco") continue
    lines.push(
      `[mcp_servers.${name}]`,
      `command = ${tomlKeyString(server.command)}`,
      `args = ${tomlStringArray(server.args)}`,
    )
    const envEntries = Object.entries(server.env)
    if (envEntries.length > 0) {
      const inline = envEntries.map(([key, value]) => `${key} = ${tomlKeyString(value)}`).join(", ")
      lines.push(`env = { ${inline} }`)
    }
    lines.push("")
  }

  writeFileSync(path, lines.join("\n"))
}

/**
 * Codex authenticates against the credentials in `<CODEX_HOME>/auth.json`.
 * Per-tenant CODEX_HOMEs would otherwise need a separate `codex login` each;
 * symlink the user's `<home>/.codex/auth.json` so all tenants share the
 * same login (memories stay isolated, auth stays singular). The source path
 * is passed in rather than read from `homedir()` directly so tests injecting
 * a different `LeucoPaths` home don't accidentally touch the real `~/.codex`.
 */
const ensureAuthSymlink = (codexHome: string, source: string): void => {
  if (!existsSync(source)) return

  const target = join(codexHome, "auth.json")
  // `existsSync` follows the link, so it returns false for a broken symlink —
  // we still need to unlink that case before re-creating, hence the explicit
  // `isSymlink` check.
  if (existsSync(target) || isSymlink(target)) {
    if (currentSymlinkTarget(target) === source) return
    unlinkSync(target)
  }
  symlinkSync(source, target)
}

const isSymlink = (path: string): boolean => {
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

const tomlStringArray = (values: string[]): string => {
  return `[${values.map(tomlKeyString).join(", ")}]`
}
