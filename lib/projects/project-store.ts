import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
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
 * `~/.leuco/projects/<projectName>/` whose `settings.json` (chmod 600) holds
 * the full registration tree — agents, channels, and per-channel secrets
 * (slack tokens, etc.) — in one place. The set of projects is just the
 * contents of the directory; cross-project settings live in
 * `~/.leuco/settings.json`.
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

  list(): Project[] | Error {
    const root = this.paths.projectsRoot()
    if (!existsSync(root)) return []

    try {
      const entries = readdirSync(root, { withFileTypes: true })
      const projects: Project[] = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        if (!existsSync(this.paths.projectSettingsPath(entry.name))) continue
        const project = this.load(entry.name)
        if (project instanceof Error) return project
        projects.push(project)
      }
      return projects
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  load(projectName: string): Project | Error {
    const path = this.paths.projectSettingsPath(projectName)
    if (!existsSync(path)) return new Error(`project not found: ${projectName}`)

    try {
      const text = readFileSync(path, "utf8")
      const json = JSON.parse(text)
      return projectSchema.parse(json)
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  save(project: Project): string | Error {
    const path = this.paths.projectSettingsPath(project.name)

    try {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(path, `${JSON.stringify(project, null, 2)}\n`)
      chmodSync(path, 0o600)
      return path
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  remove(projectName: string): void {
    rmSync(this.paths.projectDir(projectName), { recursive: true, force: true })
  }

  resolveByCwd(cwd: string): Project | Error {
    const cwdAbs = resolvePath(cwd)
    const list = this.list()
    if (list instanceof Error) return list

    const match = list.find((p) => resolvePath(p.path) === cwdAbs)
    if (!match) {
      return new Error(
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
  setAgentThreadId(
    projectName: string,
    agentName: string,
    codexThreadId: string | null,
  ): string | Error {
    const project = this.load(projectName)
    if (project instanceof Error) return project

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
    if (!touched) return new Error(`agent '${agentName}' not found in project '${projectName}'`)

    return this.save({ ...project, agents: nextAgents })
  }

  /**
   * Append a `ScheduleEntry` to the named schedule channel. The entry id and
   * name must both be unique within the channel — duplicate ids are a bug
   * (caller generates UUIDs); duplicate names would make CLI/MCP delete-by-name
   * ambiguous.
   */
  addScheduleEntry(input: {
    projectName: string
    agentName: string
    channelName: string
    entry: ScheduleEntry
  }): string | Error {
    return this.mutateScheduleChannel(input, (channel) => {
      if (channel.entries.some((e) => e.id === input.entry.id)) {
        return new Error(`schedule entry id already exists: ${input.entry.id}`)
      }
      if (channel.entries.some((e) => e.name === input.entry.name)) {
        return new Error(`schedule entry name already exists: ${input.entry.name}`)
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
    projectName: string
    agentName: string
    channelName: string
    entryIdOrName: string
  }): string | Error {
    return this.mutateScheduleChannel(input, (channel) => {
      const before = channel.entries.length
      const next = channel.entries.filter(
        (e) => e.id !== input.entryIdOrName && e.name !== input.entryIdOrName,
      )
      if (next.length === before) {
        return new Error(`schedule entry not found: ${input.entryIdOrName}`)
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
    projectName: string
    agentName: string
    channelName: string
    entryId: string
    patch: Partial<ScheduleEntry>
  }): string | Error {
    return this.mutateScheduleChannel(input, (channel) => {
      let touched = false
      const next = channel.entries.map((e) => {
        if (e.id !== input.entryId) return e
        touched = true
        return { ...e, ...input.patch, id: e.id }
      })
      if (!touched) return new Error(`schedule entry not found: ${input.entryId}`)
      return { ...channel, entries: next }
    })
  }

  private mutateScheduleChannel(
    input: { projectName: string; agentName: string; channelName: string },
    transform: (channel: ScheduleChannelWritable) => ScheduleChannelWritable | Error,
  ): string | Error {
    const project = this.load(input.projectName)
    if (project instanceof Error) return project

    const agentIndex = project.agents.findIndex((a) => a.name === input.agentName)
    if (agentIndex < 0) {
      return new Error(`agent '${input.agentName}' not found in project '${input.projectName}'`)
    }

    const agent = project.agents[agentIndex]!
    const channelIndex = agent.channels.findIndex((c) => c.name === input.channelName)
    if (channelIndex < 0) {
      return new Error(
        `channel '${input.channelName}' not found in ${input.projectName}/${input.agentName}`,
      )
    }

    const channel = agent.channels[channelIndex]!
    if (channel.type !== "schedule") {
      return new Error(`channel '${input.channelName}' is not a schedule channel`)
    }

    const updated = transform(channel)
    if (updated instanceof Error) return updated

    const nextChannels: Channel[] = agent.channels.slice()
    nextChannels[channelIndex] = updated

    const nextAgents = project.agents.slice()
    nextAgents[agentIndex] = { ...agent, channels: nextChannels }

    return this.save({ ...project, agents: nextAgents })
  }
}

type ScheduleChannelWritable = Extract<Channel, { type: "schedule" }>
