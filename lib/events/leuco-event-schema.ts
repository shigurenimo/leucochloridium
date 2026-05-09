import { z } from "zod"
import { slackEventSchema } from "@/channels/slack/slack-event-schema"

const baseTs = { ts: z.number() }

const logEventSchema = z.object({
  ...baseTs,
  type: z.literal("log"),
  level: z.enum(["info", "warn", "error"]),
  line: z.string(),
})

const tenantStartedSchema = z.object({
  ...baseTs,
  type: z.literal("tenant.started"),
  project: z.string(),
  agent: z.string(),
})

const tenantStoppedSchema = z.object({
  ...baseTs,
  type: z.literal("tenant.stopped"),
  project: z.string(),
  agent: z.string(),
})

const engineReconcileSchema = z.object({
  ...baseTs,
  type: z.literal("engine.reconcile"),
  added: z.array(z.string()),
  removed: z.array(z.string()),
})

const slackEventEnvelopeSchema = z.object({
  ...baseTs,
  type: z.literal("slack.event"),
  project: z.string(),
  agent: z.string(),
  channel: z.string(),
  event: slackEventSchema,
})

const turnStartSchema = z.object({
  ...baseTs,
  type: z.literal("turn.start"),
  project: z.string(),
  agent: z.string(),
  threadKey: z.string(),
  input: z.string(),
})

const turnCompleteSchema = z.object({
  ...baseTs,
  type: z.literal("turn.complete"),
  project: z.string(),
  agent: z.string(),
  threadKey: z.string(),
  reply: z.string(),
})

const turnErrorSchema = z.object({
  ...baseTs,
  type: z.literal("turn.error"),
  project: z.string(),
  agent: z.string(),
  threadKey: z.string(),
  error: z.string(),
})

const codexNotificationSchema = z.object({
  ...baseTs,
  type: z.literal("codex.notification"),
  project: z.string(),
  agent: z.string(),
  method: z.string(),
  params: z.unknown(),
})

const scheduleFiredSchema = z.object({
  ...baseTs,
  type: z.literal("schedule.fired"),
  project: z.string(),
  agent: z.string(),
  channel: z.string(),
  entryId: z.string(),
  entryName: z.string(),
  runAt: z.string(),
  kind: z.enum(["cron", "one-shot"]),
})

export const leucoEventSchema = z.discriminatedUnion("type", [
  logEventSchema,
  tenantStartedSchema,
  tenantStoppedSchema,
  engineReconcileSchema,
  slackEventEnvelopeSchema,
  turnStartSchema,
  turnCompleteSchema,
  turnErrorSchema,
  codexNotificationSchema,
  scheduleFiredSchema,
])
