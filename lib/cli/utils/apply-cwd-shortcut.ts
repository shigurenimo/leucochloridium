import type { Project } from "@/config/config-schema"
import type { LeucoProjectStore } from "@/projects/project-store"

const SHORTCUT_PREFIXES = new Set(["connectors"])

type Props = {
  args: string[]
  cwd: string
  projectStore: LeucoProjectStore
  scopedProject: Project | null
}

/**
 * If the first argv token is `connectors`, inject `projects <projectName>`
 * before the rest of the args. A project runtime Codex scope always wins; an operator
 * shell falls back to matching the current working directory.
 */
export const applyCwdShortcut = (props: Props): string[] => {
  const head = props.args[0]
  if (head === undefined || !SHORTCUT_PREFIXES.has(head)) return props.args

  if (props.scopedProject !== null) {
    return ["projects", props.scopedProject.name, ...props.args]
  }

  // `resolveByCwd` throws for an unregistered cwd; the shortcut is
  // best-effort so fall through to normal routing instead of crashing the
  // CLI before the router even sees the command.
  try {
    const project = props.projectStore.resolveByCwd(props.cwd)
    return ["projects", project.name, ...props.args]
  } catch {
    return props.args
  }
}
