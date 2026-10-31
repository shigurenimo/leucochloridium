import { filesystemPathSchema } from "@/config/filesystem-path-schema"
import { createLiteralRecordSchema } from "@/config/create-literal-record-schema"
import {
  SCHEDULE_THREAD_KEY_PREFIX,
  prepareScheduleInput,
} from "@/connectors/schedule/prepare-schedule-input"
import { MAX_THREAD_KEY_CHARACTERS, MAX_TURN_INPUT_BYTES } from "@/turn-input-limits"
import { parseScheduleRunAt } from "@/connectors/schedule/parse-schedule-run-at"
import { errorMessage } from "@/error-message"
import { MAX_TIMER_DELAY_MS } from "@/timer-limits"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { codexThreadIdSchema } from "@/codex-thread-id-schema"

export const scheduleEntrySchema = z
  .strictObject({
    id: z
      .string()
      .min(1)
      .max(MAX_THREAD_KEY_CHARACTERS - SCHEDULE_THREAD_KEY_PREFIX.length)
      .describe(
        `At most ${MAX_THREAD_KEY_CHARACTERS - SCHEDULE_THREAD_KEY_PREFIX.length} UTF-16 code units; the schedule prefix shares the thread key limit.`,
      ),
    name: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    runAt: z
      .string()
      .min(1)
      .superRefine((runAt, context) => {
        try {
          parseScheduleRunAt(runAt)
        } catch (error) {
          context.addIssue({ code: "custom", message: errorMessage(error) })
        }
      })
      .describe(
        "Five-field cron or saved legacy parseable timestamp. New or retimed one-shots require a real ISO calendar date-time with Z or an explicit numeric UTC offset. Stored past/legacy entries remain readable.",
      ),
    prompt: z
      .string()
      .min(1)
      .regex(/\S/, "Scheduled prompt must contain non-whitespace text")
      .max(MAX_TURN_INPUT_BYTES)
      .describe("Formatted input including schedule context must fit 262144 UTF-8 bytes."),
    enabled: z.boolean().default(true),
  })
  .superRefine((entry, context) => {
    if (
      !entry.id ||
      entry.id.length > MAX_THREAD_KEY_CHARACTERS - SCHEDULE_THREAD_KEY_PREFIX.length
    )
      return
    try {
      prepareScheduleInput(entry)
    } catch (error) {
      context.addIssue({ code: "custom", message: errorMessage(error) })
    }
  })

const slackSchema = z.strictObject({
  credential: z.uuid(),
  ackMode: z.enum(["off", "mention", "always"]).default("mention"),
})

export const settingsSchema = z
  .strictObject({
    version: z.literal(4).default(4),
    cwd: filesystemPathSchema.refine(isAbsolute, "cwd must be absolute").nullable().default(null),
    soul: filesystemPathSchema.refine(isAbsolute, "soul must be absolute").nullable().default(null),
    model: z
      .string()
      .min(1)
      .regex(/\S/, "model must contain non-whitespace text")
      .nullable()
      .default(null),
    slack: slackSchema.nullable().default(null),
    schedules: z.array(scheduleEntrySchema).default([]),
    turnTimeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).default(600_000),
    idleTimeoutMs: z.number().int().positive().max(MAX_TIMER_DELAY_MS).default(120_000),
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
  threads: createLiteralRecordSchema(
    z.object({ id: codexThreadIdSchema, context: z.string() }),
  ).default({}),
  scheduleLastFiredAt: createLiteralRecordSchema(z.number()).default({}),
  scheduleLastRunAt: createLiteralRecordSchema(scheduleEntrySchema.shape.runAt).optional(),
})

export type LeucoSettings = z.infer<typeof settingsSchema>
export type LeucoState = z.infer<typeof stateSchema>
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>
