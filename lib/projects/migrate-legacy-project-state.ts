import { existsSync } from "node:fs"
import { z } from "zod"
import { atomicWriteJson } from "@/fs/atomic-write-json"
import type { LeucoPaths } from "@/paths/leuco-paths"
import { projectStateSchema } from "@/projects/project-state-schema"

const legacyProjectSchema = z.object({
  id: z.uuid(),
  state: projectStateSchema.optional(),
})

export function migrateLegacyProjectState(rawSettings: unknown, paths: LeucoPaths): void {
  const shell = z.object({ projects: z.array(z.unknown()).default([]) }).safeParse(rawSettings)
  if (!shell.success) return

  for (const candidate of shell.data.projects) {
    const parsed = legacyProjectSchema.safeParse(candidate)
    if (!parsed.success || parsed.data.state === undefined) continue

    const statePath = paths.projectStatePath(parsed.data.id)
    if (existsSync(statePath)) continue

    atomicWriteJson({
      path: statePath,
      data: parsed.data.state,
      mode: 0o600,
    })
  }
}
