import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { z } from "zod"
import { type Channel, type Project, type ScheduleEntry } from "@/config/config-schema"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import { withFileLock } from "@/fs/with-file-lock"
import { globalSettingsSchema } from "@/global-settings/global-settings-schema"
import { LeucoPaths } from "@/paths/leuco-paths"

export type LeucoProjectStoreProps = {
  paths?: LeucoPaths
}

type ScheduleChannelWritable = Extract<Channel, { type: "schedule" }>

/**
 * Project registry backed by the `projects` array inside
 * `~/.leuco/settings.json`. All CRUD goes through a single atomic file
 * (chmod 600 because channel configs embed Slack tokens). Per-project
 * runtime state is stored with the project in that file; each project's
 * CODEX_HOME stays in its UUID directory under `~/.leuco/projects/<id>/`.
 */
export class LeucoProjectStore {
  private readonly paths: LeucoPaths

  constructor(props: LeucoProjectStoreProps = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  getPaths(): LeucoPaths {
    return this.paths
  }

  list(): Project[] {
    return this.readSettings().projects
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
