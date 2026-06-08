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
 * `~/.leuco/settings.json` (chmod 600).
 *
 * Idempotent: each step inspects current state and is a no-op when already done.
 */
export class LeucoProjectScaffolder {
  private readonly paths: LeucoPaths

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    Object.freeze(this)
  }

  create(createProps: CreateProps): ProjectScaffoldResult {
    const target = createProps.path

    const dir = ensureDir(target)
    const git = ensureGit(target)
    const registered = registerInStore(target, createProps, this.paths)

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
): RegisterResult => {
  const store = new LeucoProjectStore({ paths })
  const list = store.list()

  const samePath = list.find((p) => p.path === target)
  if (samePath) {
    return { configPath: paths.settingsPath(), step: "exists" }
  }

  const project: Project = {
    id: crypto.randomUUID(),
    name: createProps.name,
    path: target,
    version: 2,
    enabled: true,
    useCommonInstructions: true,
    prompts: ["friendly"],
    channels: [],
    mcpServers: {},
    state: { codexThreadId: null, scheduleLastFiredAt: {} },
  }
  const saved = store.save(project)

  return { configPath: saved, step: "registered" }
}
