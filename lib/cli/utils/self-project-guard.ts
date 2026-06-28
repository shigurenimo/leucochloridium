import { normalize } from "node:path"
import type { Project } from "@/config/config-schema"

export const isCurrentCodexProject = (
  project: Project,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const codexHome = env.CODEX_HOME
  if (typeof codexHome !== "string" || codexHome.length === 0) return false

  const normalizedCodexHome = normalize(codexHome).replace(/\/+$/, "")
  return normalizedCodexHome.endsWith(normalize(`/projects/${project.id}/.codex`))
}

export const selfProjectGuardMessage = (projectName: string, action: string): string => {
  return [
    `leuco: refusing to ${action} project "${projectName}" from inside its own Codex session.`,
    "This would terminate the running agent. Re-run with --force from an operator shell if you really want this.",
  ].join(" ")
}
