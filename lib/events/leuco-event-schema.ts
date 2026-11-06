import { errorDetailsSchema } from "@/error-details-schema"
import { z } from "zod"
import { leucoSlackSourceStatusSchema } from "@/connectors/slack/leuco-slack-event-source"
import { slackEventSchema } from "@/connectors/slack/slack-event-schema"

const baseTs = {
  ts: z.number(),
  instanceId: z.string().optional(),
  requestId: z.string().optional(),
}

const logEventSchema = z.object({
  ...baseTs,
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  line: z.string(),
  causes: errorDetailsSchema.optional(),
})

const runtimeStartedSchema = z.object({
  ...baseTs,
  type: z.literal("runtime.started"),
})

const runtimeStoppedSchema = z.object({
  ...baseTs,
  type: z.literal("runtime.stopped"),
})

const slackEventEnvelopeSchema = z.object({
  ...baseTs,
  type: z.literal("slack.event"),
  event: slackEventSchema,
})

const slackConnectionSchema = z.object({
  ...baseTs,
  type: z.literal("slack.connection"),
  status: leucoSlackSourceStatusSchema,
})

const slackErrorSchema = z.object({
  ...baseTs,
  type: z.literal("slack.error"),
  level: z.enum(["warn", "error"]),
  action: z.string(),
  message: z.string(),
  error: z.string().nullable(),
  causes: errorDetailsSchema.optional(),
})

const turnStartSchema = z.object({
  ...baseTs,
  type: z.literal("turn.start"),
  threadKey: z.string(),
  input: z.string(),
  inputChars: z.number().int().nonnegative().optional(),
  inputTruncated: z.boolean().optional(),
  batchSize: z.number().int().positive().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
})

const turnQueuedSchema = z.object({
  ...baseTs,
  type: z.literal("turn.queued"),
  threadKey: z.string(),
  queueDepth: z.number().int().positive(),
  queueBytes: z.number().int().nonnegative().optional(),
})

const turnRejectedSchema = z.object({
  ...baseTs,
  type: z.literal("turn.rejected"),
  threadKey: z.string(),
  reason: z.enum([
    "runtime_stopped",
    "input_bytes_limit",
    "queue_count_limit",
    "queue_bytes_limit",
  ]),
  queueDepth: z.number().int().nonnegative(),
  queueBytes: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  maxQueueDepth: z.number().int().nonnegative(),
  maxQueueBytes: z.number().int().nonnegative(),
})

const turnCompleteSchema = z.object({
  ...baseTs,
  type: z.literal("turn.complete"),
  threadKey: z.string(),
  reply: z.string(),
  replyChars: z.number().int().nonnegative().optional(),
  replyTruncated: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
})

const turnErrorSchema = z.object({
  causes: errorDetailsSchema.optional(),
  phase: z.string().optional(),
  cancelled: z.boolean().optional(),
  ...baseTs,
  type: z.literal("turn.error"),
  threadKey: z.string(),
  error: z.string(),
  durationMs: z.number().nonnegative().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
})

const codexNotificationSchema = z.object({
  ...baseTs,
  type: z.literal("codex.notification"),
  method: z.string(),
  params: z.unknown(),
})

const scheduleFiredSchema = z.object({
  ...baseTs,
  type: z.literal("schedule.fired"),
  entryId: z.string(),
  entryName: z.string(),
  runAt: z.string(),
  kind: z.enum(["cron", "one-shot"]),
})

const maintenanceEventSchema = z.object({
  ...baseTs,
  type: z.literal("maintenance"),
  operationId: z.string(),
  status: z.enum(["accepted", "stopping", "starting", "ready", "failed", "uncertain"]),
  workerPid: z.number().nullable(),
  oldPid: z.number().nullable(),
  newPid: z.number().nullable(),
  error: z.string().nullable(),
})

export const leucoEventSchema = z.discriminatedUnion("type", [
  maintenanceEventSchema,
  logEventSchema,
  runtimeStartedSchema,
  runtimeStoppedSchema,
  slackEventEnvelopeSchema,
  slackConnectionSchema,
  slackErrorSchema,
  turnQueuedSchema,
  turnRejectedSchema,
  turnStartSchema,
  turnCompleteSchema,
  turnErrorSchema,
  codexNotificationSchema,
  scheduleFiredSchema,
])
