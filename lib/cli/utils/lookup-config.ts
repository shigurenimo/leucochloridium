import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import type { Env } from "@/cli/cli-factory"
import type { Channel, Project } from "@/config/config-schema"
import type { LeucoProjectStore } from "@/projects/project-store"

export const resolveProject = (
  context: Context<Env>,
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
  context: Context<Env>,
  store: LeucoProjectStore,
  name: string | null,
): Project => {
  if (name !== null) return resolveProject(context, store, name)

  const projectIdScope = context.var.projectIdScope ?? null
  if (projectIdScope === null) {
    throw new HTTPException(400, {
      message: "--project is required outside a tenant Codex session",
    })
  }

  return store.load(projectIdScope)
}

export const resolveProjectFilter = (
  context: Context<Env>,
  store: LeucoProjectStore,
  name: string | null,
): string | null => {
  if ((context.var.projectIdScope ?? null) === null) return name
  return resolveProjectArgument(context, store, name).name
}

export const findChannel = (project: Project, name: string): Channel => {
  const channel = project.channels.find((ch) => ch.name === name)
  if (!channel) throw new Error(`channel '${name}' not found in project '${project.name}'`)
  return channel
}

const projectScopeError = (name: string): HTTPException =>
  new HTTPException(403, {
    message: `this Codex session is locked to a different project; refusing project "${name}"`,
  })
