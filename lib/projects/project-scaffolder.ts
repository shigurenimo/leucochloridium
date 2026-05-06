import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import type { Project } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

type Props = {
  paths?: LeucoPaths
}

type CreateProps = {
  path: string
  name: string
}

type DirStatus = "created" | "exists"
type GitStatus = "initialized" | "exists" | "skipped"
type RegistrationStatus = "registered" | "exists"

export type ProjectScaffoldResult = {
  path: string
  configPath: string
  steps: {
    dir: DirStatus
    git: GitStatus
    project: RegistrationStatus
  }
}

/**
 * Scaffolds a leuco-ready repository at <path>: ensures the directory exists,
 * runs `git init` if needed, and registers the project in
 * `~/.leuco/projects/<name>/settings.json` (chmod 600). Tokens, persona TOML,
 * and channels are added later by the matching `agents add` / `channels add`
 * commands.
 *
 * Idempotent: each step inspects current state and is a no-op when already done.
 */
export class LeucoProjectScaffolder {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  create(createProps: CreateProps): ProjectScaffoldResult | Error {
    const target = createProps.path

    const dir = ensureDir(target)
    const git = ensureGit(target)

    const registered = registerInStore(target, createProps, this.paths)
    if (registered instanceof Error) return registered

    return {
      path: target,
      configPath: registered.configPath,
      steps: { dir, git, project: registered.step },
    }
  }
}

const ensureDir = (path: string): DirStatus => {
  if (existsSync(path)) return "exists"
  mkdirSync(path, { recursive: true })
  return "created"
}

const ensureGit = (path: string): GitStatus => {
  if (existsSync(join(path, ".git"))) return "exists"
  const result = spawnSync("git", ["init", "-q"], { cwd: path, stdio: "ignore" })
  if (result.status !== 0) return "skipped"
  return "initialized"
}

type RegisterResult = {
  configPath: string
  step: RegistrationStatus
}

const registerInStore = (
  target: string,
  createProps: CreateProps,
  paths: LeucoPaths,
): RegisterResult | Error => {
  const store = new LeucoProjectStore({ paths })
  const list = store.list()
  if (list instanceof Error) return list

  const conflictingPath = list.find((p) => p.path === target && p.name !== createProps.name)
  if (conflictingPath) {
    return new Error(
      `another project '${conflictingPath.name}' is already registered at ${target}.`,
    )
  }

  const existing = list.find((p) => p.name === createProps.name)
  if (existing && existing.path !== target) {
    return new Error(
      `project name '${createProps.name}' is already used by ${existing.path}. pass --name to choose a different identifier.`,
    )
  }

  if (existing) {
    return { configPath: paths.projectSettingsPath(existing.name), step: "exists" }
  }

  const project: Project = { name: createProps.name, path: target, agents: [] }
  const saved = store.save(project)
  if (saved instanceof Error) return saved

  return { configPath: saved, step: "registered" }
}
