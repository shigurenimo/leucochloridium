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
import { type Project, projectSchema } from "@/config/config-schema"
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
        const { codexThreadId: _drop, ...rest } = agent
        return rest
      }
      return { ...agent, codexThreadId }
    })
    if (!touched) return new Error(`agent '${agentName}' not found in project '${projectName}'`)

    return this.save({ ...project, agents: nextAgents })
  }
}
