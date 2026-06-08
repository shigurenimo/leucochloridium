import type { LeucoProjectStore } from "@/projects/project-store"

const SHORTCUT_PREFIXES = new Set(["channels"])

/**
 * If the first argv token is `channels` and the user's cwd matches a
 * registered project's path, inject `projects <projectName>` before the rest
 * of the args. Lets users type `leuco channels list` from inside the repo
 * instead of `leuco projects <p> channels list`.
 */
export const applyCwdShortcut = (
  args: string[],
  cwd: string,
  projectStore: LeucoProjectStore,
): string[] => {
  const head = args[0]
  if (head === undefined || !SHORTCUT_PREFIXES.has(head)) return args

  const project = projectStore.resolveByCwd(cwd)
  if (project instanceof Error) return args

  return ["projects", project.name, ...args]
}
