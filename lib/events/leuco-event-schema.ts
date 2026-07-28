import { z } from "zod"
import { leucoSlackSourceStatusSchema } from "@/connectors/slack/leuco-slack-event-source"
import { slackEventSchema } from "@/connectors/slack/slack-event-schema"

const baseTs = { ts: z.number() }

const logEventSchema = z.object({
  ...baseTs,
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  line: z.string(),
})

const runtimeStartedSchema = z.object({
  ...baseTs,
  type: z.literal("runtime.started"),
  project: z.string(),
})

const runtimeStoppedSchema = z.object({
  ...baseTs,
  type: z.literal("runtime.stopped"),
  project: z.string(),
})

const supervisorReconcileSchema = z.object({
  ...baseTs,
  type: z.literal("supervisor.reconcile"),
  added: z.array(z.string()),
  removed: z.array(z.string()),
})

const supervisorReconcileFailedSchema = z.object({
  ...baseTs,
  type: z.literal("supervisor.reconcile.failed"),
  reason: z.string(),
  // Project-scoped failures carry retry metadata; store-wide reconcile
  // failures retain the compact `{ reason }` shape.
  project: z.string().optional(),
  attempt: z.number().int().positive().optional(),
  retryAt: z.number().optional(),
})

const slackEventEnvelopeSchema = z.object({
  ...baseTs,
  type: z.literal("slack.event"),
  project: z.string(),
  connector: z.string(),
  event: slackEventSchema,
})

const slackConnectionSchema = z.object({
  ...baseTs,
  type: z.literal("slack.connection"),
  project: z.string(),
  connector: z.string(),
  status: leucoSlackSourceStatusSchema,
})

const slackErrorSchema = z.object({
  ...baseTs,
  type: z.literal("slack.error"),
  project: z.string(),
  connector: z.string(),
  level: z.enum(["warn", "error"]),
  action: z.string(),
  message: z.string(),
  error: z.string().nullable(),
})

const turnStartSchema = z.object({
  ...baseTs,
  type: z.literal("turn.start"),
  project: z.string(),
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
  project: z.string(),
  threadKey: z.string(),
  queueDepth: z.number().int().positive(),
  queueBytes: z.number().int().nonnegative().optional(),
})

const turnRejectedSchema = z.object({
  ...baseTs,
  type: z.literal("turn.rejected"),
  project: z.string(),
  threadKey: z.string(),
  reason: z.enum(["runtime_stopped", "queue_count_limit", "queue_bytes_limit"]),
  queueDepth: z.number().int().nonnegative(),
  queueBytes: z.number().int().nonnegative(),
  inputBytes: z.number().int().nonnegative(),
  maxQueueDepth: z.number().int().nonnegative(),
  maxQueueBytes: z.number().int().nonnegative(),
})

const turnCompleteSchema = z.object({
  ...baseTs,
  type: z.literal("turn.complete"),
  project: z.string(),
  threadKey: z.string(),
  reply: z.string(),
  replyChars: z.number().int().nonnegative().optional(),
  replyTruncated: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
})

const turnErrorSchema = z.object({
  ...baseTs,
  type: z.literal("turn.error"),
  project: z.string(),
  threadKey: z.string(),
  error: z.string(),
  durationMs: z.number().nonnegative().optional(),
  queueWaitMs: z.number().nonnegative().optional(),
})

const codexRecoverySchema = z.object({
  ...baseTs,
  type: z.literal("codex.recovery"),
  project: z.string(),
  reason: z.string(),
  status: z.enum(["succeeded", "failed"]),
  durationMs: z.number().nonnegative(),
  error: z.string().nullable(),
})

const codexNotificationSchema = z.object({
  ...baseTs,
  type: z.literal("codex.notification"),
  project: z.string(),
  method: z.string(),
  params: z.unknown(),
})

const scheduleFiredSchema = z.object({
  ...baseTs,
  type: z.literal("schedule.fired"),
  project: z.string(),
  connector: z.string(),
  entryId: z.string(),
  entryName: z.string(),
  runAt: z.string(),
  kind: z.enum(["cron", "one-shot"]),
})

export const leucoEventSchema = z.discriminatedUnion("type", [
  logEventSchema,
  runtimeStartedSchema,
  runtimeStoppedSchema,
  supervisorReconcileSchema,
  supervisorReconcileFailedSchema,
  slackEventEnvelopeSchema,
  slackConnectionSchema,
  slackErrorSchema,
  turnQueuedSchema,
  turnRejectedSchema,
  turnStartSchema,
  turnCompleteSchema,
  turnErrorSchema,
  codexRecoverySchema,
  codexNotificationSchema,
  scheduleFiredSchema,
])
