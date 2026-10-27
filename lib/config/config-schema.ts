import { isAbsolute } from "node:path"
import { z } from "zod"

export const scheduleEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  runAt: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
})

const slackSchema = z.strictObject({
  credential: z.uuid(),
  ackMode: z.enum(["off", "mention", "always"]).default("mention"),
})

export const settingsSchema = z
  .strictObject({
    version: z.literal(4).default(4),
    cwd: z.string().refine(isAbsolute, "cwd must be absolute").nullable().default(null),
    soul: z.string().refine(isAbsolute, "soul must be absolute").nullable().default(null),
    model: z.string().min(1).nullable().default(null),
    slack: slackSchema.nullable().default(null),
    schedules: z.array(scheduleEntrySchema).default([]),
    turnTimeoutMs: z.number().int().positive().default(600_000),
    idleTimeoutMs: z.number().int().positive().default(120_000),
  })
  .superRefine((settings, context) => {
    const names = new Set<string>()
    const ids = new Set<string>()
    for (const entry of settings.schedules) {
      if (names.has(entry.name) || ids.has(entry.id)) {
        context.addIssue({ code: "custom", message: "schedule names and IDs must be unique" })
      }
      names.add(entry.name)
      ids.add(entry.id)
    }
  })

export const stateSchema = z.object({
  threads: z.record(z.string(), z.object({ id: z.string(), context: z.string() })).default({}),
  scheduleLastFiredAt: z.record(z.string(), z.number()).default({}),
})

export type LeucoSettings = z.infer<typeof settingsSchema>
export type LeucoState = z.infer<typeof stateSchema>
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>
