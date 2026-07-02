import { randomBytes } from "node:crypto"
import {
  chmodSync,
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
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { tomlString } from "@/engine/codex/toml-string"
import { LeucoEngine } from "@/engine/engine"
import { LeucoPromptPresets } from "@/engine/prompt-presets"
import { tenantConfigSignature } from "@/engine/tenant-config-signature"
import { LeucoTenant } from "@/engine/tenant"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStateStore } from "@/projects/project-state-store"
import { LeucoProjectStore } from "@/projects/project-store"

type Logger = (line: string) => void

type Props = {
  env: NodeJS.ProcessEnv
  /** Gateway port. Required in production so codex children can reach the
   * daemon's HTTP MCP route at `/mcp/<projectId>`. The legacy `leuco mcp`
   * stdio fallback was removed. CLI always supplies the port via
   * `cliEnvSchema` (default 7331). Library embedders MUST supply it too —
   * skipping it leaves tenants without MCP. */
  port: number
  home?: string
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
    // events.db stores full Slack message bodies; keep it as tight as
    // settings.json instead of inheriting the umask (typically 644).
    hardenEventLogPermissions(paths.daemonEventLogPath())

    const onLog: Logger = (line) => {
      baseLog(line)
      bus.emit({ ts: Date.now(), type: "log", level: "info", line })
    }

    const projectStore = new LeucoProjectStore({ paths })
    const projectStateStore = new LeucoProjectStateStore({ projectStore })
    const projects = projectStore.list()

    // One bearer token per project, generated lazily and held for the daemon
    // lifetime: tenant A's codex child cannot present its token against
    // tenant B's `/mcp/:project` route.
    const mcpTokens = new Map<string, string>()
    const mcpTokenForProject = (projectId: string): string => {
      const existing = mcpTokens.get(projectId)
      if (existing !== undefined) return existing
      const fresh = randomBytes(32).toString("hex")
      mcpTokens.set(projectId, fresh)
      return fresh
    }
    const mcpPort = buildProps.port

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
        mcpToken: mcpTokenForProject(project.id),
        mcpPort,
      })

    const tenants: LeucoTenant[] = []
    for (const project of projects) {
      if (!project.enabled) continue
      tenants.push(buildTenantFn(project))
    }

    const engine = new LeucoEngine({
      tenants,
      port: buildProps.port,
      onLog,
      projectStore,
      buildTenant: buildTenantFn,
      bus,
      mcpTokenForProject: (projectId) => mcpTokens.get(projectId) ?? null,
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
  mcpToken: string
  mcpPort: number
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

  const codexHome = ensureCodexHome(props.paths, props.project.id)
  ensureTenantConfigToml(codexHome, {
    projectPath: props.project.path,
    projectId: props.project.id,
    projectName: props.project.name,
    mcpEndpoint: { url: `http://127.0.0.1:${props.mcpPort}/mcp/${props.project.id}` },
    extraMcpServers: props.project.mcpServers,
  })
  ensureAuthSymlink(codexHome, props.paths.codexAuthPath())

  const childEnv: NodeJS.ProcessEnv = {
    ...props.env,
    CODEX_HOME: codexHome,
    [LEUCO_MCP_TOKEN_ENV]: props.mcpToken,
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

  const presets = LeucoPromptPresets.resolveAll(props.project.prompts)

  return new LeucoTenant({
    projectId: props.project.id,
    projectName: props.project.name,
    projectPath: props.project.path,
    agentSpec: {
      model: props.project.model ?? undefined,
      developerInstructions: props.project.developerInstructions ?? undefined,
    },
    codex,
    plugins,
    onLog: props.onLog,
    bus: props.bus,
    initialCodexThreadId: props.project.state.codexThreadId ?? undefined,
    projectStateStore: props.projectStateStore,
    useCommonInstructions: props.project.useCommonInstructions,
    presets,
    configSignature: tenantConfigSignature(props.project),
  })
}

const hardenEventLogPermissions = (eventLogPath: string): void => {
  for (const path of [eventLogPath, `${eventLogPath}-wal`, `${eventLogPath}-shm`]) {
    try {
      chmodSync(path, 0o600)
    } catch {
      // sidecar files appear lazily; permissions are re-applied on next boot
    }
  }
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
    mcpEndpoint: { url: string }
    extraMcpServers: Record<string, McpServer>
  },
): void => {
  const path = join(codexHome, "config.toml")
  const autoApproveTools = [
    "slack_call",
    "slack_download_file",
    "schedule_create",
    "schedule_list",
    "schedule_delete",
  ]
  const lines = [
    `model = "gpt-5.5"`,
    `model_reasoning_effort = "xhigh"`,
    "",
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "",
    `[projects.${tomlString(tenant.projectPath)}]`,
    `trust_level = "trusted"`,
    "",
    `[mcp_servers.leuco]`,
    `url = ${tomlString(tenant.mcpEndpoint.url)}`,
    `bearer_token_env_var = "${LEUCO_MCP_TOKEN_ENV}"`,
    "",
  ]

  for (const tool of autoApproveTools) {
    lines.push(`[mcp_servers.leuco.tools.${tool}]`, `approval_mode = "approve"`, "")
  }

  for (const [name, server] of Object.entries(tenant.extraMcpServers)) {
    if (name === "leuco") continue
    lines.push(
      `[mcp_servers.${name}]`,
      `command = ${tomlString(server.command)}`,
      `args = ${tomlStringArray(server.args)}`,
    )
    const envEntries = Object.entries(server.env)
    if (envEntries.length > 0) {
      // Keys are validated as env-var names by the schema; values still need
      // full TOML string quoting.
      const inline = envEntries.map(([key, value]) => `${key} = ${tomlString(value)}`).join(", ")
      lines.push(`env = { ${inline} }`)
    }
    lines.push("")
  }

  writeFileSync(path, lines.join("\n"))
}

const ensureAuthSymlink = (codexHome: string, source: string): void => {
  if (!existsSync(source)) return

  const target = join(codexHome, "auth.json")

  if (isSymlink(target)) {
    if (currentSymlinkTarget(target) === source) return
    unlinkSync(target)
    symlinkSync(source, target)
    return
  }

  // A REGULAR auth.json means this tenant logged in separately on purpose —
  // replacing it with the shared symlink would destroy those credentials.
  if (existsSync(target)) return

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

const tomlStringArray = (values: string[]): string => {
  return `[${values.map(tomlString).join(", ")}]`
}
