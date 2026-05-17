import type { Agent, Channel, Project } from "@/config/config-schema"
import type { LeucoProjectStore } from "@/projects/project-store"

/**
 * Helpers that walk a loaded `Project` and throw a flat `Error` describing
 * exactly which segment was not found. Handlers use these to translate URL
 * params (`:project`, `:agent`, `:channel`) into typed references without
 * repeating the lookup boilerplate; the Hono `onError` in
 * `lib/cli/routes/index.ts` formats the throw into `error: <message>`.
 */

/**
 * Resolve the `:project` URL segment (always a `name`, never an id) into a
 * `Project`. Same-name registrations are disambiguated via `cwd` when
 * supplied — same rules as `LeucoProjectStore.resolveByName`.
 */
export const resolveProject = (
  store: LeucoProjectStore,
  name: string,
  opts: { preferCwd?: string } = {},
): Project => {
  return store.resolveByName(name, opts)
}

export const findAgent = (project: Project, name: string): Agent => {
  const agent = project.agents.find((a) => a.name === name)
  if (!agent) throw new Error(`agent '${name}' not found in project '${project.name}'`)
  return agent
}

export const findChannel = (agent: Agent, projectName: string, name: string): Channel => {
  const channel = agent.channels.find((ch) => ch.name === name)
  if (!channel) throw new Error(`channel '${name}' not found in ${projectName}/${agent.name}`)
  return channel
}
