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
   * Read-modify-write helper: load the project, replace the named agent's
   * `codexThreadId`, save. Pass `null` to clear the field. The persisted
   * thread id is what `LeucoTenant.ensureAgentThread()` resumes from on the
   * next daemon start.
   */
  setAgentThreadId(projectId: string, agentName: string, codexThreadId: string | null): string {
    const project = this.load(projectId)

    let touched = false
    const nextAgents = project.agents.map((agent) => {
      if (agent.name !== agentName) return agent
      touched = true
      if (codexThreadId === null) {
        return {
          name: agent.name,
          enabled: agent.enabled,
          useCommonInstructions: agent.useCommonInstructions,
          prompts: agent.prompts,
          channels: agent.channels,
        }
      }
      return { ...agent, codexThreadId }
    })
    if (!touched) throw new Error(`agent '${agentName}' not found in project '${project.name}'`)

    return this.save({ ...project, agents: nextAgents })
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
   * Load `settings.json` from a directory keyed either by UUID (current) or
   * by `name` (legacy). For the legacy case, mint a UUID, write it back into
   * `settings.json`, and rename the on-disk directory so the id becomes the
   * key going forward. After migration the directory name equals `id`.
   */
  private loadOrMigrate(dirName: string): Project {
    const path = this.paths.projectSettingsPath(dirName)
    const json: unknown = JSON.parse(readFileSync(path, "utf8"))

    const hasId = typeof (json as { id?: unknown }).id === "string"
    if (hasId) {
      const parsed = projectSchema.parse(json)
      if (parsed.id !== dirName) {
        throw new Error(`project directory name '${dirName}' does not match id '${parsed.id}'`)
      }
      return parsed
    }

    const id = crypto.randomUUID()
    const withId = { ...(json as Record<string, unknown>), id }
    const parsed = projectSchema.parse(withId)

    if (existsSync(this.paths.projectDir(id))) {
      throw new Error(`migration target already exists: ${this.paths.projectDir(id)}`)
    }

    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`)
    chmodSync(path, 0o600)
    renameSync(this.paths.projectDir(dirName), this.paths.projectDir(id))

    return parsed
  }
}

type ScheduleChannelWritable = Extract<Channel, { type: "schedule" }>
