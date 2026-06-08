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
import type { McpServer, Project } from "@/config/config-schema"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { tomlString } from "@/engine/codex/toml-string"
import { LeucoEngine } from "@/engine/engine"
import { LeucoPromptPresets } from "@/engine/prompt-presets"
import { LeucoTenant, type TenantAgentSpec } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStateStore } from "@/projects/project-state-store"
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
 * `~/.leuco/projects/<id>/settings.json`, builds one `LeucoTenant` per
 * enabled project, and wires the engine.
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

    const onLog: Logger = (line) => {
      baseLog(line)
      bus.emit({ ts: Date.now(), type: "log", level: "info", line })
    }

    const projectStore = new LeucoProjectStore({ paths })
    const projectStateStore = new LeucoProjectStateStore({ paths })
    const projects = projectStore.list()

    const mcpToken = buildProps.port !== undefined ? randomBytes(32).toString("hex") : null
    const mcpPort = buildProps.port

    const tenants: LeucoTenant[] = []
    for (const project of projects) {
      if (!project.enabled) continue
      tenants.push(
        buildTenant({
          project,
          paths,
          env: buildProps.env,
          codexBin: buildProps.codexBin,
          onLog,
          bus,
          projectStore,
          projectStateStore,
          mcpToken,
          mcpPort,
        }),
      )
    }

    const buildTenantFn = (project: Project): LeucoTenant =>
      buildTenant({
        project,
        paths,
        env: buildProps.env,
        codexBin: buildProps.codexBin,
        onLog,
        bus,
        projectStore,
        projectStateStore,
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

  async reload(): Promise<void> {
    await this.props.engine.reconcile()
  }
}

type BuildTenantProps = {
  project: Project
  paths: LeucoPaths
  env: NodeJS.ProcessEnv
  codexBin: string | undefined
  onLog: Logger
  bus: LeucoEventBus
  projectStore: LeucoProjectStore
  projectStateStore: LeucoProjectStateStore
  mcpToken: string | null
  mcpPort: number | undefined
}

const buildTenant = (props: BuildTenantProps): LeucoTenant => {
  const enabledChannels = props.project.channels.filter((ch) => ch.enabled)
  const filteredProject: Project = { ...props.project, channels: enabledChannels }

  const plugins = LeucoChannelHost.buildForProject({
    project: { id: filteredProject.id, name: filteredProject.name },
    channels: filteredProject.channels,
    projectStore: props.projectStore,
    projectStateStore: props.projectStateStore,
  })

  const tomlStore = new LeucoCodexAgentStore({ cwd: props.project.path })

  const codexHome = ensureCodexHome(props.paths, props.project.id)
  ensureTenantConfigToml(codexHome, {
    projectPath: props.project.path,
    projectId: props.project.id,
    projectName: props.project.name,
    mcpEndpoint:
      props.mcpToken !== null && props.mcpPort !== undefined
        ? { url: `http://127.0.0.1:${props.mcpPort}/mcp/${props.project.id}` }
        : null,
    extraMcpServers: props.project.mcpServers,
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
        method,
        params,
      })
    },
  })

  // Read the "main" agent TOML if one exists with the project name.
  let agentSpec: TenantAgentSpec = {}
  try {
    const spec = tomlStore.read({ scope: "project", name: props.project.name })
    agentSpec = {
      developerInstructions:
        spec.developerInstructions.length > 0 ? spec.developerInstructions : undefined,
      model: spec.model ?? undefined,
    }
  } catch {
    // No TOML for this project name — that's fine, use defaults.
  }

  const listSubagents = () =>
    tomlStore
      .list("project")
      .filter((entry) => entry.name !== props.project.name)
      .map((entry) => ({ name: entry.name, path: entry.path }))

  const presets = LeucoPromptPresets.resolveAll(props.project.prompts)

  const initialState = props.projectStateStore.load(props.project.id)

  return new LeucoTenant({
    projectId: props.project.id,
    projectName: props.project.name,
    projectPath: props.project.path,
    agentSpec,
    codex,
    plugins,
    onLog: props.onLog,
    bus: props.bus,
    initialCodexThreadId: initialState.codexThreadId ?? undefined,
    projectStateStore: props.projectStateStore,
    useCommonInstructions: props.project.useCommonInstructions,
    listSubagents,
    presets,
  })
}

const ensureCodexHome = (paths: LeucoPaths, projectId: string): string => {
  const dir = paths.projectHome(projectId)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

const ensureTenantConfigToml = (
  codexHome: string,
  tenant: {
    projectPath: string
    projectId: string
    projectName: string
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
      `args = ["mcp", "--project", ${tomlString(tenant.projectName)}]`,
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

const ensureAuthSymlink = (codexHome: string, source: string): void => {
  if (!existsSync(source)) return

  const target = join(codexHome, "auth.json")
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
