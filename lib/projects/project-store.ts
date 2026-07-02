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
import { withFileLock } from "@/fs/with-file-lock"
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
    return this.withSettingsLock(() => {
      const settings = this.readSettings()
      const migrated = this.migratePerProjectFiles(settings.projects)
      if (migrated !== null) {
        this.writeSettings({ ...settings, projects: migrated })
        return migrated
      }
      return settings.projects
    })
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
    return this.withSettingsLock(() => {
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
    })
  }

  /**
   * Read-modify-write a single project inside the settings lock. Prefer this
   * over `load()` → mutate → `save()` in any caller that can race the daemon
   * (which persists codexThreadId / scheduleLastFiredAt at its own cadence):
   * the transform always sees the freshest on-disk project, so it cannot
   * write back a stale snapshot.
   */
  updateProject(projectId: string, transform: (project: Project) => Project): Project {
    return this.withSettingsLock(() => {
      const settings = this.readSettings()
      const found = settings.projects.find((p) => p.id === projectId)
      if (!found) throw new Error(`project not found: ${projectId}`)

      const updated = transform(found)
      if (updated.id !== projectId) {
        throw new Error("updateProject: transform must not change the project id")
      }

      const next = settings.projects.map((p) => (p.id === projectId ? updated : p))
      this.writeSettings({ ...settings, projects: next })
      return updated
    })
  }

  remove(projectId: string): void {
    this.withSettingsLock(() => {
      const settings = this.readSettings()
      const next = settings.projects.filter((p) => p.id !== projectId)
      this.writeSettings({ ...settings, projects: next })
    })

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
    this.updateProject(input.projectId, (project) => {
      const channel = findScheduleChannel(project, input.channelName)

      const removedIds = channel.entries
        .filter((e) => e.id === input.entryIdOrName || e.name === input.entryIdOrName)
        .map((e) => e.id)
      if (removedIds.length === 0) {
        throw new Error(`schedule entry not found: ${input.entryIdOrName}`)
      }

      const nextEntries = channel.entries.filter((e) => !removedIds.includes(e.id))
      const nextChannels: Channel[] = project.channels.map((c) =>
        c.name === channel.name ? { ...channel, entries: nextEntries } : c,
      )

      // Drop the fired-at marks for the removed entries so state does not
      // accumulate dead UUID keys forever.
      const nextLastFiredAt = { ...project.state.scheduleLastFiredAt }
      for (const removedId of removedIds) delete nextLastFiredAt[removedId]

      return {
        ...project,
        channels: nextChannels,
        state: { ...project.state, scheduleLastFiredAt: nextLastFiredAt },
      }
    })
    return this.paths.settingsPath()
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
    // Validate on write, not just on read. Without this, one unvalidated
    // caller (e.g. a route that skips name validation) can persist a shape
    // every later readSettings() rejects — bricking every command until the
    // file is fixed by hand.
    const validated = globalSettingsSchema.parse(settings)

    return atomicWriteJson({
      path: this.paths.settingsPath(),
      data: validated,
      mode: 0o600,
    })
  }

  private withSettingsLock<T>(fn: () => T): T {
    return withFileLock({ lockPath: `${this.paths.settingsPath()}.lock` }, fn)
  }

  private mutateScheduleChannel(
    input: { projectId: string; channelName: string },
    transform: (channel: ScheduleChannelWritable) => ScheduleChannelWritable,
  ): string {
    this.updateProject(input.projectId, (project) => {
      const channel = findScheduleChannel(project, input.channelName)
      const updated = transform(channel)
      const nextChannels: Channel[] = project.channels.map((c) =>
        c.name === channel.name ? updated : c,
      )
      return { ...project, channels: nextChannels }
    })
    return this.paths.settingsPath()
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

      // Read the legacy state BEFORE loadOrMigrate: a v0 directory (no id in
      // settings.json) gets renamed to its new UUID inside loadOrMigrate, so
      // every path computed from `entry.name` is dead afterwards. Cleanup
      // below re-derives paths from the post-rename directory name — deleting
      // at the stale path was a no-op that left the id-less settings.json in
      // place, and every subsequent list() re-migrated it under a fresh UUID
      // (one duplicate project per call).
      const legacyState = hasState ? readLegacyState(legacyStatePath) : null
      let finalDirName = entry.name

      if (hasSettings) {
        const outcome = this.loadOrMigrate(entry.name)
        finalDirName = outcome.dirName
        for (const project of outcome.projects) {
          if (!byId.has(project.id)) {
            const withState = legacyState !== null ? { ...project, state: legacyState } : project
            migrated.push(withState)
            byId.set(project.id, withState)
          }
        }
      }

      if (legacyState !== null) {
        const registered = byId.get(entry.name)
        if (registered !== undefined && isEmptyState(registered.state)) {
          const patched = { ...registered, state: legacyState }
          const index = migrated.findIndex((p) => p.id === registered.id)
          if (index >= 0) migrated[index] = patched
          byId.set(registered.id, patched)
        }
      }

      rmSync(this.paths.projectSettingsPath(finalDirName), { force: true })
      rmSync(this.paths.projectStatePath(finalDirName), { force: true })
    }

    return migrated
  }

  /**
   * Load a legacy `settings.json` and run in-place migrations:
   *
   *   v0 → v1: legacy `name`-keyed directory → UUID id.
   *   v1 → v2: flatten `agents[]` into the project.
   *
   * Returns the projects plus the directory name they now live under —
   * a v0 directory is renamed to the generated UUID here, so callers must
   * not reuse paths derived from the pre-migration name.
   */
  private loadOrMigrate(dirName: string): { projects: Project[]; dirName: string } {
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
      return { projects: [projectSchema.parse(json)], dirName: id }
    }

    // --- v1 → v2: flatten agents[] into project ---

    const agents = json.agents ?? []
    if (agents.length === 0) {
      return { projects: [this.buildV2Project(id, json, null)], dirName: id }
    }

    if (agents.length === 1) {
      return { projects: [this.buildV2Project(id, json, agents[0]!)], dirName: id }
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

    return { projects: results, dirName: id }
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

const findScheduleChannel = (project: Project, channelName: string): ScheduleChannelWritable => {
  const channel = project.channels.find((c) => c.name === channelName)
  if (!channel) {
    throw new Error(`channel '${channelName}' not found in ${project.name}`)
  }
  if (channel.type !== "schedule") {
    throw new Error(`channel '${channelName}' is not a schedule channel`)
  }
  return channel
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
