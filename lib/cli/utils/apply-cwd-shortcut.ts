import type { LeucoProjectStore } from "@/projects/project-store"

const SHORTCUT_PREFIXES = new Set(["agents", "channels"])

/**
 * If the first argv token is `agents` or `channels` and the user's cwd
 * matches a registered project's path, inject `projects <projectName>` before
 * the rest of the args. Lets users type `leuco agents list` from inside the
 * repo instead of `leuco projects <p> agents list`.
 *
 * No-ops when:
 *  - the first token is not one of the shortcut prefixes
 *  - the user already typed `projects` themselves
 *  - cwd does not match any registered project
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
