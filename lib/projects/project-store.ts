import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { z } from "zod"
import {
  CURRENT_SCHEMA_VERSION,
  EMPTY_PROJECT_STATE,
  type Channel,
  type Project,
  type ProjectState,
  type ScheduleEntry,
  projectSchema,
} from "@/config/config-schema"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { globalSettingsSchema } from "@/global-settings/global-settings-schema"
import { LeucoPaths } from "@/paths/leuco-paths"

/**
 * Loose shape used only by `loadOrMigrate` to walk a legacy settings.json
 * before strict `projectSchema.parse` runs. `passthrough()` keeps every
 * unknown field so the post-migration shape still validates.
 */
const migrationShape = z
  .object({
    id: z.string().optional(),
    version: z.number().optional(),
    agents: z
      .array(
        z
          .object({
            name: z.string().optional(),
            enabled: z.boolean().optional(),
            useCommonInstructions: z.boolean().optional(),
            prompts: z.array(z.string()).optional(),
            channels: z.array(z.unknown()).optional(),
            mcpServers: z.record(z.string(), z.unknown()).optional(),
            codexThreadId: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

type Props = {
  paths?: LeucoPaths
}

type ScheduleChannelWritable = Extract<Channel, { type: "schedule" }>

/**
 * Project registry backed by the `projects` array inside
 * `~/.leuco/settings.json`. All CRUD goes through a single atomic file
 * (chmod 600 because channel configs embed Slack tokens). Per-project
 * runtime state (codexThreadId, .codex/) stays in UUID directories under
 * `~/.leuco/projects/<id>/`.
 *
 * On first `list()`, legacy per-project `settings.json` files (pre-0.10)
 * are migrated into the unified file automatically.
 */
export class LeucoProjectStore {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  getPaths(): LeucoPaths {
    return this.paths
  }

  list(): Project[] {
    const settings = this.readSettings()
    const migrated = this.migratePerProjectFiles(settings.projects)
    if (migrated !== null) {
      this.writeSettings({ ...settings, projects: migrated })
      return migrated
    }
    return settings.projects
  }

  load(projectId: string): Project {
    const settings = this.readSettings()
    const found = settings.projects.find((p) => p.id === projectId)
    if (!found) throw new Error(`project not found: ${projectId}`)
    return found
  }

  resolveByName(name: string, opts: { preferCwd?: string } = {}): Project {
    const list = this.list()
    const matches = list.filter((p) => p.name === name)
    if (matches.length === 0) throw new Error(`project not found: ${name}`)
    if (matches.length === 1) return matches[0]!

    if (opts.preferCwd) {
      const cwdAbs = resolvePath(opts.preferCwd)
      const cwdMatch = matches.find((p) => resolvePath(p.path) === cwdAbs)
      if (cwdMatch) return cwdMatch
    }

    const paths = matches.map((p) => p.path).join(", ")
    throw new Error(
      `multiple projects named '${name}' (${paths}). disambiguate by running from one of those directories, or rename one of them with a different --name.`,
    )
  }

  save(project: Project): string {
    const settings = this.readSettings()
    const index = settings.projects.findIndex((p) => p.id === project.id)
    const next = settings.projects.slice()

    if (index >= 0) {
      next[index] = project
    } else {
      next.push(project)
    }

    const projectDir = this.paths.projectDir(project.id)
    if (!existsSync(projectDir)) mkdirSync(projectDir, { recursive: true })

    return this.writeSettings({ ...settings, projects: next })
  }

  remove(projectId: string): void {
    const settings = this.readSettings()
    const next = settings.projects.filter((p) => p.id !== projectId)
    this.writeSettings({ ...settings, projects: next })

    rmSync(this.paths.projectDir(projectId), { recursive: true, force: true })
  }

  resolveByCwd(cwd: string): Project {
    const cwdAbs = resolvePath(cwd)
    const list = this.list()
    const match = list.find((p) => resolvePath(p.path) === cwdAbs)
    if (!match) {
      throw new Error(
        `no project registered at ${cwdAbs}. run \`leuco projects create ${cwdAbs}\` or \`leuco projects add ${cwdAbs}\`.`,
      )
    }
    return match
  }

  addScheduleEntry(input: {
    projectId: string
    channelName: string
    entry: ScheduleEntry
  }): string {
    return this.mutateScheduleChannel(input, (channel) => {
      if (channel.entries.some((e) => e.id === input.entry.id)) {
        throw new Error(`schedule entry id already exists: ${input.entry.id}`)
      }
      if (channel.entries.some((e) => e.name === input.entry.name)) {
        throw new Error(`schedule entry name already exists: ${input.entry.name}`)
      }
      return { ...channel, entries: [...channel.entries, input.entry] }
    })
  }

  removeScheduleEntry(input: {
    projectId: string
    channelName: string
    entryIdOrName: string
  }): string {
    return this.mutateScheduleChannel(input, (channel) => {
      const before = channel.entries.length
      const next = channel.entries.filter(
        (e) => e.id !== input.entryIdOrName && e.name !== input.entryIdOrName,
      )
      if (next.length === before) {
        throw new Error(`schedule entry not found: ${input.entryIdOrName}`)
      }
      return { ...channel, entries: next }
    })
  }

  updateScheduleEntry(input: {
    projectId: string
    channelName: string
    entryId: string
    patch: Partial<ScheduleEntry>
  }): string {
    return this.mutateScheduleChannel(input, (channel) => {
      let touched = false
      const next = channel.entries.map((e) => {
        if (e.id !== input.entryId) return e
        touched = true
        return { ...e, ...input.patch, id: e.id }
      })
      if (!touched) throw new Error(`schedule entry not found: ${input.entryId}`)
      return { ...channel, entries: next }
    })
  }

  private readSettings(): z.infer<typeof globalSettingsSchema> {
    const path = this.paths.settingsPath()
    if (!existsSync(path)) return globalSettingsSchema.parse(undefined)

    const raw = readFileSync(path, "utf8")
    const json: unknown = JSON.parse(raw)
    return globalSettingsSchema.parse(json)
  }

  private writeSettings(settings: z.infer<typeof globalSettingsSchema>): string {
    return atomicWriteJson({
      path: this.paths.settingsPath(),
      data: settings,
      mode: 0o600,
    })
  }

  private mutateScheduleChannel(
    input: { projectId: string; channelName: string },
    transform: (channel: ScheduleChannelWritable) => ScheduleChannelWritable,
  ): string {
    const project = this.load(input.projectId)

    const channelIndex = project.channels.findIndex((c) => c.name === input.channelName)
    if (channelIndex < 0) {
      throw new Error(`channel '${input.channelName}' not found in ${project.name}`)
    }

    const channel = project.channels[channelIndex]!
    if (channel.type !== "schedule") {
      throw new Error(`channel '${input.channelName}' is not a schedule channel`)
    }

    const updated = transform(channel)

    const nextChannels: Channel[] = project.channels.slice()
    nextChannels[channelIndex] = updated

    return this.save({ ...project, channels: nextChannels })
  }

  // ---------------------------------------------------------------------------
  // Migration: per-project settings.json / state.json → unified file
  // ---------------------------------------------------------------------------

  /**
   * Scan `~/.leuco/projects/` for legacy per-project files.
   * - `settings.json`: migrated as a new project entry
   * - `state.json`: merged into the project's `state` field
   * Returns the merged array if anything was found, or null if clean.
   */
  private migratePerProjectFiles(existing: Project[]): Project[] | null {
    const root = this.paths.projectsRoot()
    if (!existsSync(root)) return null

    const entries = readdirSync(root, { withFileTypes: true })
    const byId = new Map(existing.map((p) => [p.id, p]))
    let migrated: Project[] | null = null

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const legacySettingsPath = this.paths.projectSettingsPath(entry.name)
      const legacyStatePath = this.paths.projectStatePath(entry.name)
      const hasSettings = existsSync(legacySettingsPath)
      const hasState = existsSync(legacyStatePath)
      if (!hasSettings && !hasState) continue

      if (migrated === null) migrated = existing.slice()

      if (hasSettings) {
        for (const project of this.loadOrMigrate(entry.name)) {
          if (!byId.has(project.id)) {
            const state = hasState ? readLegacyState(legacyStatePath) : project.state
            const withState = { ...project, state }
            migrated.push(withState)
            byId.set(project.id, withState)
          }
        }
        rmSync(legacySettingsPath, { force: true })
      }

      if (hasState) {
        const existing = byId.get(entry.name)
        if (existing !== undefined && isEmptyState(existing.state)) {
          const state = readLegacyState(legacyStatePath)
          const patched = { ...existing, state }
          const index = migrated.findIndex((p) => p.id === existing.id)
          if (index >= 0) migrated[index] = patched
          byId.set(existing.id, patched)
        }
        rmSync(legacyStatePath, { force: true })
      }
    }

    return migrated
  }

  /**
   * Load a legacy `settings.json` and run in-place migrations:
   *
   *   v0 → v1: legacy `name`-keyed directory → UUID id.
   *   v1 → v2: flatten `agents[]` into the project.
   *
   * Returns an array because a multi-agent project splits into N projects.
   */
  private loadOrMigrate(dirName: string): Project[] {
    const path = this.paths.projectSettingsPath(dirName)
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    const json = migrationShape.parse(raw)

    let id: string
    if (typeof json.id === "string") {
      id = json.id
      if (id !== dirName) {
        throw new Error(`project directory name '${dirName}' does not match id '${id}'`)
      }
    } else {
      id = crypto.randomUUID()
      json.id = id
    }

    if (id !== dirName) {
      if (existsSync(this.paths.projectDir(id))) {
        throw new Error(`migration target already exists: ${this.paths.projectDir(id)}`)
      }
      renameSync(this.paths.projectDir(dirName), this.paths.projectDir(id))
    }

    const currentVersion = json.version ?? 1

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      return [projectSchema.parse(json)]
    }

    // --- v1 → v2: flatten agents[] into project ---

    const agents = json.agents ?? []
    if (agents.length === 0) {
      return [this.buildV2Project(id, json, null)]
    }

    if (agents.length === 1) {
      return [this.buildV2Project(id, json, agents[0]!)]
    }

    const results: Project[] = []
    results.push(this.buildV2Project(id, json, agents[0]!))

    for (let i = 1; i < agents.length; i++) {
      const agent = agents[i]!
      const newId = crypto.randomUUID()
      const newDir = this.paths.projectDir(newId)
      mkdirSync(newDir, { recursive: true })
      const newJson = {
        ...json,
        id: newId,
        name: `${json.name}-${agent.name ?? i}`,
        agents: undefined,
      }
      results.push(this.buildV2Project(newId, newJson, agent))
    }

    const legacyAgentsRoot = this.paths.legacyAgentsRoot(id)
    if (existsSync(legacyAgentsRoot)) {
      try {
        rmSync(legacyAgentsRoot, { recursive: true, force: true })
      } catch {
        // best-effort cleanup
      }
    }

    return results
  }

  /**
   * Build a single v2 Project from a v1 JSON + one optional agent.
   * Migrates agent's `.codex/` or `home/` into `projects/<id>/.codex/`.
   */
  private buildV2Project(
    projectId: string,
    baseJson: Record<string, unknown>,
    agent: Record<string, unknown> | null,
  ): Project {
    const flat: Record<string, unknown> = {
      ...baseJson,
      version: CURRENT_SCHEMA_VERSION,
      agents: undefined,
    }

    if (agent !== null) {
      if (agent.enabled !== undefined) flat.enabled = agent.enabled
      if (agent.useCommonInstructions !== undefined) {
        flat.useCommonInstructions = agent.useCommonInstructions
      }
      if (agent.prompts !== undefined) flat.prompts = agent.prompts
      if (agent.channels !== undefined) flat.channels = agent.channels
      if (agent.mcpServers !== undefined) flat.mcpServers = agent.mcpServers
    }

    delete flat.agents

    const parsed = projectSchema.parse(flat)

    if (agent !== null && typeof agent.name === "string") {
      this.migrateAgentHome(projectId, agent.name)
      this.migrateAgentState(projectId, agent.name)
    }

    return parsed
  }

  private migrateAgentHome(projectId: string, agentName: string): void {
    const target = this.paths.projectHome(projectId)
    if (existsSync(target)) return

    const codexVariant = this.paths.legacyAgentCodex(projectId, agentName)
    if (existsSync(codexVariant)) {
      renameSync(codexVariant, target)
      return
    }

    const homeVariant = this.paths.legacyAgentHome(projectId, agentName)
    if (existsSync(homeVariant)) {
      renameSync(homeVariant, target)
    }
  }

  private migrateAgentState(projectId: string, agentName: string): void {
    const target = this.paths.projectStatePath(projectId)
    if (existsSync(target)) return

    const legacy = this.paths.legacyAgentStatePath(projectId, agentName)
    if (existsSync(legacy)) {
      renameSync(legacy, target)
    }
  }
}

const legacyStateSchema = z.object({
  codexThreadId: z.string().min(1).nullable().default(null),
  scheduleLastFiredAt: z.record(z.string(), z.number()).default({}),
})

const readLegacyState = (path: string): ProjectState => {
  try {
    const raw = readFileSync(path, "utf8")
    return legacyStateSchema.parse(JSON.parse(raw))
  } catch {
    return EMPTY_PROJECT_STATE
  }
}

const isEmptyState = (state: ProjectState): boolean =>
  state.codexThreadId === null && Object.keys(state.scheduleLastFiredAt).length === 0
