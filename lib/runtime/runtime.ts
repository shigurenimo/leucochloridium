import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs"
import { join } from "node:path"
import pkg from "../../package.json" with { type: "json" }
import { LeucoChannelHost } from "@/channels/channel-host"
import type { McpServer, Project } from "@/config/config-schema"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { tomlString } from "@/engine/codex/toml-string"
import { toBoundedCodexNotification } from "@/engine/codex/to-bounded-codex-notification"
import { LeucoEngine } from "@/engine/engine"
import { tenantConfigSignature } from "@/engine/tenant-config-signature"
import { LeucoTenant } from "@/engine/tenant"
import { DEFAULT_LEUCO_PORT } from "@/env/cli-env-schema"
import { errorMessage } from "@/error-message"
import { LeucoEventBus } from "@/events/leuco-event-bus"
import { atomicWriteText } from "@/fs/atomic-write-text"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStateStore } from "@/projects/project-state-store"
import { LeucoProjectStore } from "@/projects/project-store"
import { LeucoPromptPresets } from "@/prompts/presets"
import { buildCodexChildEnv } from "@/runtime/build-codex-child-env"

type Logger = (line: string) => void

export type LeucoRuntimeProps = {
  env: NodeJS.ProcessEnv
  /** Loopback gateway port for daemon health, status, and thread control. */
  port?: number
  home?: string
  codexBin?: string
  onLog?: Logger
  /** Dependency seam for runtime composition tests. */
  buildTenantForProject?: (project: Project) => LeucoTenant
  /** Optional override owned and closed by the runtime. */
  eventBus?: LeucoEventBus
}

/**
 * Composition root: reads every registered project from unified settings,
 * builds one `LeucoTenant` per enabled project, and wires the engine.
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

  static build(buildProps: LeucoRuntimeProps): LeucoRuntime {
    const baseLog = buildProps.onLog ?? ((line: string) => process.stdout.write(`${line}\n`))
    const paths = new LeucoPaths({ home: buildProps.home })
    const bus =
      buildProps.eventBus ?? new LeucoEventBus({ eventLogPath: paths.daemonEventLogPath() })
    // events.db stores full Slack message bodies; keep it as tight as
    // settings.json instead of inheriting the umask (typically 644).
    hardenEventLogPermissions(paths.daemonEventLogPath())

    const onLog: Logger = (line) => {
      baseLog(line)
      bus.emit({ ts: Date.now(), type: "log", level: "info", line })
    }

    const projectStore = new LeucoProjectStore({ paths })
    const projectStateStore = new LeucoProjectStateStore({ projectStore })
    const globalSettings = new LeucoGlobalSettingsStore({ paths }).loadRuntimeSettings()
    if (globalSettings instanceof Error) throw globalSettings
    const runnableProjects = projectStore.listRunnable()
    const projects = runnableProjects.projects
    for (const issue of runnableProjects.issues) {
      const reason = `project ${issue.project} is invalid and was skipped: ${issue.error}`
      onLog(`[leuco] ${reason}`)
      bus.emit({
        ts: Date.now(),
        type: "engine.reconcile.failed",
        reason,
        project: issue.project,
      })
    }

    const gatewayPort = buildProps.port ?? DEFAULT_LEUCO_PORT

    const buildTenantFn =
      buildProps.buildTenantForProject ??
      ((project: Project): LeucoTenant =>
        buildTenant({
          project,
          paths,
          env: buildProps.env,
          codexBin: buildProps.codexBin,
          onLog,
          bus,
          projectStore,
          projectStateStore,
          turnTimeoutMs: globalSettings.turnTimeoutMs,
          turnIdleTimeoutMs: globalSettings.turnIdleTimeoutMs,
          turnConcurrency: globalSettings.turnConcurrency,
          turnQueueMaxItems: globalSettings.turnQueueMaxItems,
          turnQueueMaxBytes: globalSettings.turnQueueMaxBytes,
        }))

    const tenants: LeucoTenant[] = []
    for (const project of projects) {
      if (!project.enabled) continue
      try {
        tenants.push(buildTenantFn(project))
      } catch (err) {
        const reason = `tenant ${project.name} initial build failed: ${errorMessage(err)}`
        onLog(`[leuco] ${reason}; deferring to reconcile supervisor`)
        bus.emit({
          ts: Date.now(),
          type: "engine.reconcile.failed",
          reason,
          project: project.name,
        })
      }
    }

    const engine = new LeucoEngine({
      tenants,
      port: gatewayPort,
      onLog,
      projectStore,
      buildTenant: buildTenantFn,
      bus,
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
    // A project whose synchronous composition failed above is absent from the
    // initial tenant array. Reconcile immediately so the engine records its
    // retry state; later attempts then use the normal bounded supervisor.
    await this.props.engine.reconcile()
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
  turnTimeoutMs: number
  turnIdleTimeoutMs: number
  turnConcurrency: number
  turnQueueMaxItems: number
  turnQueueMaxBytes: number
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
    extraMcpServers: props.project.mcpServers,
  })
  ensureAuthSymlink(codexHome, props.paths.codexAuthPath())

  const childEnv = buildCodexChildEnv({
    env: props.env,
    codexHome,
    projectId: props.project.id,
  })

  const codex = new LeucoCodexClient({
    bin: props.codexBin,
    cwd: props.project.path,
    env: childEnv,
    onLog: (line) => props.onLog(`[${props.project.name}] ${line}`),
    clientVersion: pkg.version,
    onAnyNotification: (method, params) => {
      const notification = toBoundedCodexNotification(method, params)
      if (notification === null) return

      props.bus.emit({
        ts: Date.now(),
        type: "codex.notification",
        project: props.project.name,
        method: notification.method,
        params: notification.params,
      })
    },
  })

  const presets = LeucoPromptPresets.resolveAll(props.project.prompts)

  return new LeucoTenant({
    projectId: props.project.id,
    projectName: props.project.name,
    projectPath: props.project.path,
    codexHome,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    agentSpec: {
      model: props.project.model ?? undefined,
      developerInstructions: props.project.developerInstructions ?? undefined,
    },
    codex,
    plugins,
    onLog: props.onLog,
    bus: props.bus,
    conversationScope: props.project.conversationScope,
    initialCodexThreadId: props.project.state.codexThreadId ?? undefined,
    initialCodexThreadIds: props.project.state.codexThreadIds,
    projectStateStore: props.projectStateStore,
    useCommonInstructions: props.project.useCommonInstructions,
    presets,
    configSignature: tenantConfigSignature(props.project),
    turnTimeoutMs: props.turnTimeoutMs,
    turnIdleTimeoutMs: props.turnIdleTimeoutMs,
    turnConcurrency: props.turnConcurrency,
    turnQueueMaxItems: props.turnQueueMaxItems,
    turnQueueMaxBytes: props.turnQueueMaxBytes,
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
    extraMcpServers: Record<string, McpServer>
  },
): void => {
  const path = join(codexHome, "config.toml")
  const lines = [
    `model = "gpt-5.6-terra"`,
    `model_reasoning_effort = "xhigh"`,
    // Bound every tool source, including project-provided MCP servers that do
    // not pass through Leuco's own response serializer.
    `tool_output_token_limit = 20000`,
    "",
    `approval_policy = "never"`,
    `sandbox_mode = "danger-full-access"`,
    "",
    `[projects.${tomlString(tenant.projectPath)}]`,
    `trust_level = "trusted"`,
    "",
  ]

  for (const [name, server] of Object.entries(tenant.extraMcpServers)) {
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

  atomicWriteText({ path, text: lines.join("\n"), mode: 0o600 })
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

  // A regular file can be a deliberate tenant-specific login. Replacing it
  // would destroy credentials merely because the runtime was rebuilt.
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

const tomlStringArray = (values: string[]): string => {
  return `[${values.map(tomlString).join(", ")}]`
}

const currentSymlinkTarget = (path: string): string | null => {
  try {
    if (!lstatSync(path).isSymbolicLink()) return null
    return readlinkSync(path)
  } catch {
    return null
  }
}
