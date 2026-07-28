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
import { LeucoConnectorHost } from "@/connectors/connector-host"
import type { Connector } from "@/connectors/connector"
import type { McpServer, Project } from "@/config/config-schema"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import { tomlString } from "@/engine/codex/toml-string"
import { toBoundedCodexNotification } from "@/engine/codex/to-bounded-codex-notification"
import { LeucoProjectSupervisor } from "@/project/project-supervisor"
import { projectRuntimeSignature } from "@/project/project-runtime-signature"
import { LeucoProjectRuntime } from "@/project/project-runtime"
import { DEFAULT_LEUCO_PORT } from "@/env/cli-env-schema"
import { errorMessage } from "@/error-message"
import { LeucoEventJournal } from "@/events/leuco-event-journal"
import { atomicWriteText } from "@/fs/atomic-write-text"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"
import { LeucoGatewayServer, type LeucoGatewayServerProps } from "@/gateway/gateway-server"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStateStore } from "@/projects/project-state-store"
import { LeucoProjectStore } from "@/projects/project-store"
import { LeucoPromptPresets } from "@/prompts/presets"
import { buildCodexChildEnv } from "@/runtime/build-codex-child-env"

type Logger = (line: string) => void

type GatewayLifecycle = {
  start(): unknown
  stop(): Promise<void>
}

export type LeucoRuntimeProps = {
  env: NodeJS.ProcessEnv
  /** Loopback gateway port for daemon health, status, and thread control. */
  port?: number
  home?: string
  codexBin?: string
  onLog?: Logger
  /** Dependency seam for runtime composition tests. */
  buildProjectRuntime?: (project: Project) => LeucoProjectRuntime
  /** Builds one fresh connector for targeted hot restart. */
  buildProjectConnector?: (project: Project, connectorName: string) => Connector
  /** Optional override owned and closed by the runtime. */
  eventJournal?: LeucoEventJournal
  buildGateway?: (props: LeucoGatewayServerProps) => GatewayLifecycle
}

/**
 * Composition root: reads every registered project from unified settings,
 * builds one `LeucoProjectRuntime` per enabled project, and wires the engine.
 */
export class LeucoRuntime {
  private constructor(
    private readonly props: {
      projectStore: LeucoProjectStore
      supervisor: LeucoProjectSupervisor
      gateway: GatewayLifecycle
      journal: LeucoEventJournal
      onLog: Logger
    },
  ) {
    Object.freeze(this)
  }

  static build(buildProps: LeucoRuntimeProps): LeucoRuntime {
    const baseLog = buildProps.onLog ?? ((line: string) => process.stdout.write(`${line}\n`))
    const paths = new LeucoPaths({ home: buildProps.home })
    const journal =
      buildProps.eventJournal ?? new LeucoEventJournal({ eventLogPath: paths.daemonEventLogPath() })
    // events.db stores full Slack message bodies; keep it as tight as
    // settings.json instead of inheriting the umask (typically 644).
    hardenEventLogPermissions(paths.daemonEventLogPath())

    const onLog: Logger = (line) => {
      baseLog(line)
      journal.append({ ts: Date.now(), type: "log", level: "info", line })
    }

    const projectStore = new LeucoProjectStore({ paths })
    const projectStateStore = new LeucoProjectStateStore({ paths })
    const globalSettings = new LeucoGlobalSettingsStore({ paths }).loadRuntimeSettings()
    if (globalSettings instanceof Error) throw globalSettings
    const runnableProjects = projectStore.listRunnable()
    const projects = runnableProjects.projects
    for (const issue of runnableProjects.issues) {
      const reason = `project ${issue.project} is invalid and was skipped: ${issue.error}`
      onLog(`[leuco] ${reason}`)
      journal.append({
        ts: Date.now(),
        type: "supervisor.reconcile.failed",
        reason,
        project: issue.project,
      })
    }

    const gatewayPort = buildProps.port ?? DEFAULT_LEUCO_PORT

    const buildRuntimeFn =
      buildProps.buildProjectRuntime ??
      ((project: Project): LeucoProjectRuntime =>
        buildProjectRuntime({
          project,
          paths,
          env: buildProps.env,
          codexBin: buildProps.codexBin,
          onLog,
          journal,
          projectStore,
          projectStateStore,
          turnTimeoutMs: globalSettings.turnTimeoutMs,
          turnIdleTimeoutMs: globalSettings.turnIdleTimeoutMs,
          turnConcurrency: globalSettings.turnConcurrency,
          turnQueueMaxItems: globalSettings.turnQueueMaxItems,
          turnQueueMaxBytes: globalSettings.turnQueueMaxBytes,
        }))

    const runtimes: LeucoProjectRuntime[] = []
    for (const project of projects) {
      if (!project.enabled) continue
      try {
        runtimes.push(buildRuntimeFn(project))
      } catch (err) {
        const reason = `runtime ${project.name} initial build failed: ${errorMessage(err)}`
        onLog(`[leuco] ${reason}; deferring to reconcile supervisor`)
        journal.append({
          ts: Date.now(),
          type: "supervisor.reconcile.failed",
          reason,
          project: project.name,
        })
      }
    }

    const supervisor = new LeucoProjectSupervisor({
      runtimes,
      onLog,
      projectStore,
      buildProjectRuntime: buildRuntimeFn,
      buildProjectConnector:
        buildProps.buildProjectConnector ??
        ((project, connectorName) =>
          buildProjectConnector({
            project,
            connectorName,
            projectStore,
            projectStateStore,
          })),
      journal,
    })
    const gatewayProps: LeucoGatewayServerProps = {
      control: supervisor,
      port: gatewayPort,
      onLog,
    }
    const gateway = buildProps.buildGateway
      ? buildProps.buildGateway(gatewayProps)
      : new LeucoGatewayServer(gatewayProps)

    return new LeucoRuntime({
      projectStore,
      supervisor,
      gateway,
      journal,
      onLog,
    })
  }

  getSupervisor(): LeucoProjectSupervisor {
    return this.props.supervisor
  }

  getProjectStore(): LeucoProjectStore {
    return this.props.projectStore
  }

  async start(): Promise<void> {
    this.props.gateway.start()
    try {
      await this.props.supervisor.start()
      // A project whose synchronous composition failed above is absent from
      // the initial runtime array. Reconcile immediately so the supervisor
      // records its retry state.
      await this.props.supervisor.reconcile()
    } catch (error) {
      await this.stopGateway("startup rollback")
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.props.supervisor.stop()
    await this.stopGateway("shutdown")
    this.props.journal.close()
  }

  async reload(): Promise<void> {
    await this.props.supervisor.reconcile()
  }

  private async stopGateway(context: string): Promise<void> {
    try {
      await this.props.gateway.stop()
    } catch (error) {
      this.props.onLog(`[leuco] ${context}: gateway stop failed: ${errorMessage(error)}`)
    }
  }
}

type BuildProjectConnectorProps = {
  project: Project
  connectorName: string
  projectStore: LeucoProjectStore
  projectStateStore: LeucoProjectStateStore
}

const buildProjectConnector = (props: BuildProjectConnectorProps): Connector => {
  const connector = props.project.connectors.find(
    (candidate) => candidate.name === props.connectorName,
  )
  if (connector === undefined) throw new Error(`connector not found: ${props.connectorName}`)

  return LeucoConnectorHost.buildConnector({
    project: { id: props.project.id, name: props.project.name },
    connector,
    projectStore: props.projectStore,
    projectStateStore: props.projectStateStore,
  })
}

type BuildProjectRuntimeProps = {
  project: Project
  paths: LeucoPaths
  env: NodeJS.ProcessEnv
  codexBin: string | undefined
  onLog: Logger
  journal: LeucoEventJournal
  projectStore: LeucoProjectStore
  projectStateStore: LeucoProjectStateStore
  turnTimeoutMs: number
  turnIdleTimeoutMs: number
  turnConcurrency: number
  turnQueueMaxItems: number
  turnQueueMaxBytes: number
}

const buildProjectRuntime = (props: BuildProjectRuntimeProps): LeucoProjectRuntime => {
  const enabledConnectors = props.project.connectors.filter((connector) => connector.enabled)
  const filteredProject: Project = { ...props.project, connectors: enabledConnectors }

  const connectors = LeucoConnectorHost.buildForProject({
    project: { id: filteredProject.id, name: filteredProject.name },
    connectors: filteredProject.connectors,
    projectStore: props.projectStore,
    projectStateStore: props.projectStateStore,
  })

  const codexHome = ensureCodexHome(props.paths, props.project.id)
  ensureProjectCodexConfig(codexHome, {
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

      props.journal.append({
        ts: Date.now(),
        type: "codex.notification",
        project: props.project.name,
        method: notification.method,
        params: notification.params,
      })
    },
  })

  const presets = LeucoPromptPresets.resolveAll(props.project.prompts)
  const state = props.projectStateStore.load(props.project.id)

  return new LeucoProjectRuntime({
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
    connectors,
    onLog: props.onLog,
    journal: props.journal,
    conversationScope: props.project.conversationScope,
    initialCodexThreadId: state.codexThreadId ?? undefined,
    initialCodexThreadIds: state.codexThreadIds,
    projectStateStore: props.projectStateStore,
    useCommonInstructions: props.project.useCommonInstructions,
    presets,
    configSignature: projectRuntimeSignature(props.project),
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

const ensureProjectCodexConfig = (
  codexHome: string,
  runtime: {
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
    `[projects.${tomlString(runtime.projectPath)}]`,
    `trust_level = "trusted"`,
    "",
  ]

  for (const [name, server] of Object.entries(runtime.extraMcpServers)) {
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

  // A regular file can be a deliberate runtime-specific login. Replacing it
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
