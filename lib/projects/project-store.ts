import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { z } from "zod"
import {
  CURRENT_SCHEMA_VERSION,
  type Channel,
  type Project,
  type ScheduleEntry,
  projectSchema,
} from "@/config/config-schema"
import { atomicWriteJson } from "@/fs/atomic-write-json"
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
 * Per-project JSON store. Each registered project owns a directory at
 * `~/.leuco/projects/<id>/` keyed by UUID, whose `settings.json` (chmod 600)
 * holds the full registration tree — name, channels, and per-channel secrets
 * — in one place. The set of projects is just the contents of the directory;
 * cross-project settings live in `~/.leuco/settings.json`.
 *
 * On first load, legacy settings (pre-0.9 agents array, name-keyed dirs,
 * inline codexThreadId) are migrated transparently by `loadOrMigrate`. The
 * `version` field in settings.json tracks schema revision.
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
    const root = this.paths.projectsRoot()
    if (!existsSync(root)) return []

    const entries = readdirSync(root, { withFileTypes: true })
    const projects: Project[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const settingsPath = this.paths.projectSettingsPath(entry.name)
      if (!existsSync(settingsPath)) continue
      projects.push(...this.loadOrMigrate(entry.name))
    }
    return projects
  }

  load(projectId: string): Project {
    const path = this.paths.projectSettingsPath(projectId)
    if (!existsSync(path)) throw new Error(`project not found: ${projectId}`)

    const text = readFileSync(path, "utf8")
    const json = JSON.parse(text)
    return projectSchema.parse(json)
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
    return atomicWriteJson({
      path: this.paths.projectSettingsPath(project.id),
      data: project,
      mode: 0o600,
    })
  }

  remove(projectId: string): void {
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

  /**
   * Load `settings.json` and run in-place migrations:
   *
   *   v0 → v1: legacy `name`-keyed directory → UUID id.
   *   v1 → v2: flatten `agents[]` into the project. Each agent becomes its
   *            own project when there are 2+. The on-disk `agents/` tree is
   *            consolidated into `projects/<id>/.codex/`.
   *
   * Returns an array because a multi-agent project splits into N projects.
   */
  private loadOrMigrate(dirName: string): Project[] {
    const path = this.paths.projectSettingsPath(dirName)
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"))
    const json = migrationShape.parse(raw)

    let id: string
    let mutated = false
    if (typeof json.id === "string") {
      id = json.id
      if (id !== dirName) {
        throw new Error(`project directory name '${dirName}' does not match id '${id}'`)
      }
    } else {
      id = crypto.randomUUID()
      json.id = id
      mutated = true
    }

    const currentVersion = json.version ?? 1

    if (currentVersion >= CURRENT_SCHEMA_VERSION) {
      if (id !== dirName) {
        if (existsSync(this.paths.projectDir(id))) {
          throw new Error(`migration target already exists: ${this.paths.projectDir(id)}`)
        }
        renameSync(this.paths.projectDir(dirName), this.paths.projectDir(id))
      }
      if (mutated) {
        atomicWriteJson({ path: this.paths.projectSettingsPath(id), data: json, mode: 0o600 })
      }
      return [projectSchema.parse(json)]
    }

    // --- v1 → v2: flatten agents[] into project ---

    if (id !== dirName) {
      if (existsSync(this.paths.projectDir(id))) {
        throw new Error(`migration target already exists: ${this.paths.projectDir(id)}`)
      }
      renameSync(this.paths.projectDir(dirName), this.paths.projectDir(id))
    }

    const agents = json.agents ?? []
    if (agents.length === 0) {
      return [this.writeV2Project(id, json, null)]
    }

    if (agents.length === 1) {
      return [this.writeV2Project(id, json, agents[0]!)]
    }

    // Multi-agent: first agent stays in the original project dir, rest get new project dirs.
    const results: Project[] = []
    results.push(this.writeV2Project(id, json, agents[0]!))

    for (let i = 1; i < agents.length; i++) {
      const agent = agents[i]!
      const newId = crypto.randomUUID()
      const newName = typeof agent.name === "string" ? `${json.name}-${agent.name}` : json.name
      const newDir = this.paths.projectDir(newId)
      mkdirSync(newDir, { recursive: true })

      const newJson = { ...json, id: newId, name: newName, agents: undefined }
      results.push(this.writeV2Project(newId, newJson, agent))
    }

    // Clean up empty agents/ dir if all homes have been moved.
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
   * Write a single v2 project from a v1 JSON + one optional agent.
   * Migrates agent's `.codex/` or `home/` into `projects/<id>/.codex/`.
   */
  private writeV2Project(
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

    // Delete the flattened agents key completely.
    delete flat.agents

    const parsed = projectSchema.parse(flat)
    atomicWriteJson({ path: this.paths.projectSettingsPath(projectId), data: parsed, mode: 0o600 })

    // Migrate the agent's CODEX_HOME to project level.
    if (agent !== null && typeof agent.name === "string") {
      this.migrateAgentHome(projectId, agent.name)
      this.migrateAgentState(projectId, agent.name)
    }

    return parsed
  }

  /** Move `agents/<name>/.codex/` or `agents/<name>/home/` → `projects/<id>/.codex/`. */
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

  /** Move `agents/<name>/state.json` → `projects/<id>/state.json`. */
  private migrateAgentState(projectId: string, agentName: string): void {
    const target = this.paths.projectStatePath(projectId)
    if (existsSync(target)) return

    const legacy = this.paths.legacyAgentStatePath(projectId, agentName)
    if (existsSync(legacy)) {
      renameSync(legacy, target)
    }
  }
}
