import { z } from "zod"

export const projectStateSchema = z.object({
  codexThreadId: z.string().min(1).nullable().default(null),
  codexThreadIds: z.record(z.string(), z.string().min(1)).default({}),
  scheduleLastFiredAt: z.record(z.string(), z.number()).default({}),
})

export type ProjectState = z.infer<typeof projectStateSchema>

export const EMPTY_PROJECT_STATE: ProjectState = {
  codexThreadId: null,
  codexThreadIds: {},
  scheduleLastFiredAt: {},
}
