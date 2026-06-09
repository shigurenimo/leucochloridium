import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { dirname, resolve as resolvePath } from "node:path"
import {
  type Channel,
  type Project,
  type ScheduleEntry,
  projectSchema,
} from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"

type Props = {
  paths?: LeucoPaths
}

/**
 * Per-project JSON store. Each registered project owns a directory at
 * `~/.leuco/projects/<id>/` keyed by UUID, whose `settings.json` (chmod 600)
 * holds the full registration tree — name, agents, channels, and per-channel
 * secrets — in one place. The set of projects is just the contents of the
 * directory; cross-project settings live in `~/.leuco/settings.json`.
 *
 * Legacy installs whose directories were keyed by `name` (pre-id) are
 * migrated transparently on `list()`: a UUID is generated, written into
 * `settings.json`, and the directory is renamed to match. After migration the
 * id is stable and rename / move become metadata edits.
 *
 * Errors are thrown, never returned. Handlers catch nothing — the Hono
 * `onError` in `lib/cli/routes/index.ts` formats `HTTPException`s and any
 * other throws as `error: <message>`.
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
    this.migrateLegacyRootSettings()

    const root = this.paths.projectsRoot()
    if (!existsSync(root)) return []

    const entries = readdirSync(root, { withFileTypes: true })
    const projects: Project[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const settingsPath = this.paths.projectSettingsPath(entry.name)
      if (!existsSync(settingsPath)) continue
      projects.push(this.loadOrMigrate(entry.name))
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

  /**
   * Resolve a user-supplied project `name` to a `Project`. The CLI always
   * receives a name (the URL segment is human-typed), but the on-disk store
   * is keyed by `id`. Same-name projects are allowed when their `path`
   * differs; the caller can disambiguate via `cwd` by passing the optional
   * `preferCwd` so the project whose `path` matches `cwd` wins.
   */
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
    const path = this.paths.projectSettingsPath(project.id)
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`)
    chmodSync(path, 0o600)
    return path
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

  /**
   * Append a `ScheduleEntry` to the named schedule channel. The entry id and
   * name must both be unique within the channel — duplicate ids are a bug
   * (caller generates UUIDs); duplicate names would make CLI/MCP delete-by-name
   * ambiguous.
   */
  addScheduleEntry(input: {
    projectId: string
    agentName: string
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

  /**
   * Remove a single schedule entry from the named channel. The entry is
   * matched by id first, then by name — codex always knows the id but the
   * CLI usually only has the name.
   */
  removeScheduleEntry(input: {
    projectId: string
    agentName: string
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

  /**
   * Update one entry in place (matched by id). Used by the schedule plugin
   * to flip `enabled = false` on a one-shot after firing — kept as a generic
   * mutator so future per-entry state (lastFiredAt, fail count) can land
   * here without another helper.
   */
  updateScheduleEntry(input: {
    projectId: string
    agentName: string
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
    input: { projectId: string; agentName: string; channelName: string },
    transform: (channel: ScheduleChannelWritable) => ScheduleChannelWritable,
  ): string {
    const project = this.load(input.projectId)

    const agentIndex = project.agents.findIndex((a) => a.name === input.agentName)
    if (agentIndex < 0) {
      throw new Error(`agent '${input.agentName}' not found in project '${project.name}'`)
    }

    const agent = project.agents[agentIndex]!
    const channelIndex = agent.channels.findIndex((c) => c.name === input.channelName)
    if (channelIndex < 0) {
      throw new Error(
        `channel '${input.channelName}' not found in ${project.name}/${input.agentName}`,
      )
    }

    const channel = agent.channels[channelIndex]!
    if (channel.type !== "schedule") {
      throw new Error(`channel '${input.channelName}' is not a schedule channel`)
    }

    const updated = transform(channel)

    const nextChannels: Channel[] = agent.channels.slice()
    nextChannels[channelIndex] = updated

    const nextAgents = project.agents.slice()
    nextAgents[agentIndex] = { ...agent, channels: nextChannels }

    return this.save({ ...project, agents: nextAgents })
  }

  /**
   * Load `settings.json` and run any in-place migrations. Two are folded in
   * here so a daemon start picks up legacy installs without an extra command:
   *
   *   1. legacy `name`-keyed directory → UUID id. Mints `id`, writes it into
   *      `settings.json`, and renames the directory so the id becomes the
   *      key going forward.
   *   2. legacy `agents[i].codexThreadId` → `agents/<a>/state.json`. The
   *      thread id was carried inside `settings.json` until 0.7.x; it now
   *      lives in a separate state file so the settings surface stays
   *      idempotent. Each migrated thread is dropped from `settings.json`
   *      and written into the corresponding `state.json`.
   *
   * After both migrations the directory name equals `id` and no
   * `codexThreadId` remains anywhere in `settings.json`.
   */
  private loadOrMigrate(dirName: string): Project {
    const path = this.paths.projectSettingsPath(dirName)
    const json = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

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

    const threadMigrations: Array<{ agentName: string; threadId: string }> = []
    if (Array.isArray(json.agents)) {
      for (const entry of json.agents) {
        if (entry === null || typeof entry !== "object") continue
        const agent = entry as Record<string, unknown>
        const threadId = agent.codexThreadId
        const agentName = agent.name
        if (typeof threadId === "string" && threadId.length > 0 && typeof agentName === "string") {
          threadMigrations.push({ agentName, threadId })
          delete agent.codexThreadId
          mutated = true
        }
      }
    }

    const parsed = projectSchema.parse(json)

    if (id !== dirName) {
      if (existsSync(this.paths.projectDir(id))) {
        throw new Error(`migration target already exists: ${this.paths.projectDir(id)}`)
      }
      renameSync(this.paths.projectDir(dirName), this.paths.projectDir(id))
    }

    if (mutated) {
      const settingsPath = this.paths.projectSettingsPath(id)
      writeFileSync(settingsPath, `${JSON.stringify(parsed, null, 2)}\n`)
      chmodSync(settingsPath, 0o600)
    }

    for (const migration of threadMigrations) {
      const statePath = this.paths.agentStatePath(id, migration.agentName)
      const stateDir = dirname(statePath)
      if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
      if (!existsSync(statePath)) {
        writeFileSync(
          statePath,
          `${JSON.stringify({ codexThreadId: migration.threadId }, null, 2)}\n`,
        )
      }
    }

    return parsed
  }

  /**
   * Legacy 0.7-style installs kept every project in the global
   * `~/.leuco/settings.json` as `projects[]`, with channels/state directly on
   * each project. Newer leuco stores one settings file per project and one
   * default agent per legacy project. Copy those registrations forward on
   * first read so upgrading does not make `leuco projects` look empty.
   */
  private migrateLegacyRootSettings(): void {
    const path = this.paths.settingsPath()
    if (!existsSync(path)) return

    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    if (!Array.isArray(raw.projects)) return

    for (const legacyEntry of raw.projects) {
      if (legacyEntry === null || typeof legacyEntry !== "object") continue
      const legacy = legacyEntry as Record<string, unknown>
      if (Array.isArray(legacy.agents)) continue

      const name = legacy.name
      const projectPath = legacy.path
      if (typeof name !== "string" || typeof projectPath !== "string") continue

      const id = typeof legacy.id === "string" ? legacy.id : crypto.randomUUID()
      if (existsSync(this.paths.projectSettingsPath(id))) continue

      const project = projectSchema.parse({
        id,
        name,
        path: projectPath,
        agents: [
          {
            name,
            enabled: typeof legacy.enabled === "boolean" ? legacy.enabled : true,
            useCommonInstructions:
              typeof legacy.useCommonInstructions === "boolean"
                ? legacy.useCommonInstructions
                : true,
            prompts: Array.isArray(legacy.prompts) ? legacy.prompts : ["friendly"],
            channels: Array.isArray(legacy.channels) ? legacy.channels : [],
            mcpServers:
              legacy.mcpServers !== null && typeof legacy.mcpServers === "object"
                ? legacy.mcpServers
                : {},
          },
        ],
      })

      this.save(project)

      const state = legacy.state
      if (state !== null && typeof state === "object") {
        const legacyState = state as Record<string, unknown>
        const codexThreadId = legacyState.codexThreadId
        const scheduleLastFiredAt = legacyState.scheduleLastFiredAt
        const statePath = this.paths.agentStatePath(id, name)
        const stateDir = dirname(statePath)
        if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
        if (!existsSync(statePath)) {
          writeFileSync(
            statePath,
            `${JSON.stringify(
              {
                codexThreadId: typeof codexThreadId === "string" ? codexThreadId : null,
                scheduleLastFiredAt:
                  scheduleLastFiredAt !== null && typeof scheduleLastFiredAt === "object"
                    ? scheduleLastFiredAt
                    : {},
              },
              null,
              2,
            )}\n`,
          )
          chmodSync(statePath, 0o600)
        }
      }
    }
  }
}

type ScheduleChannelWritable = Extract<Channel, { type: "schedule" }>
