import type { Channel, Project } from "@/config/config-schema"
import type { LeucoProjectStore } from "@/projects/project-store"

export const resolveProject = (
  store: LeucoProjectStore,
  name: string,
  opts: { preferCwd?: string } = {},
): Project => {
  return store.resolveByName(name, opts)
}

export const findChannel = (project: Project, name: string): Channel => {
  const channel = project.channels.find((ch) => ch.name === name)
  if (!channel) throw new Error(`channel '${name}' not found in project '${project.name}'`)
  return channel
}
