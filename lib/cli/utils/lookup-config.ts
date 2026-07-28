import { HTTPException } from "hono/http-exception"
import type { CliContext } from "@/cli/cli-factory"
import type { ConnectorConfig, Project } from "@/config/config-schema"
import type { LeucoProjectStore } from "@/projects/project-store"

export const resolveProject = (
  context: CliContext,
  store: LeucoProjectStore,
  name: string,
): Project => {
  const projectIdScope = context.var.projectIdScope ?? null
  if (projectIdScope !== null) {
    const scopedProject = store.load(projectIdScope)
    if (scopedProject.name === name) return scopedProject
    throw projectScopeError(name)
  }

  return store.resolveByName(name, { preferCwd: context.var.cwd })
}

export const resolveProjectArgument = (
  context: CliContext,
  store: LeucoProjectStore,
  name: string | null,
): Project => {
  if (name !== null) return resolveProject(context, store, name)

  const projectIdScope = context.var.projectIdScope ?? null
  if (projectIdScope === null) {
    throw new HTTPException(400, {
      message: "--project is required outside a project runtime Codex session",
    })
  }

  return store.load(projectIdScope)
}

export const resolveProjectFilter = (
  context: CliContext,
  store: LeucoProjectStore,
  name: string | null,
): string | null => {
  if ((context.var.projectIdScope ?? null) === null) return name
  return resolveProjectArgument(context, store, name).name
}

export const findConnector = (project: Project, name: string): ConnectorConfig => {
  const connector = project.connectors.find((candidate) => candidate.name === name)
  if (!connector) throw new Error(`connector '${name}' not found in project '${project.name}'`)
  return connector
}

const projectScopeError = (name: string): HTTPException =>
  new HTTPException(403, {
    message: `this Codex session is locked to a different project; refusing project "${name}"`,
  })
