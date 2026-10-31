import { z } from "zod"

const routingStringSchema = z.string().regex(/\S/, "Slack routing field must not be blank")

/** Subset of `app_mention` event fields the listener actually needs. */
export const slackAppMentionEventSchema = z.object({
  channel: routingStringSchema,
  user: routingStringSchema.optional(),
  text: z.string().optional(),
  ts: routingStringSchema,
  thread_ts: routingStringSchema.optional(),
  bot_id: z.string().optional(),
})

/** Subset of `message` event fields used as fallback when `app_mention` is not subscribed. */
export const slackMessageEventSchema = z.object({
  channel: routingStringSchema,
  user: routingStringSchema.optional(),
  text: z.string().optional(),
  ts: routingStringSchema,
  thread_ts: routingStringSchema.optional(),
  subtype: z.string().optional(),
  bot_id: z.string().optional(),
})

/** Subset of `reaction_added` / `reaction_removed` event fields we forward. */
export const slackReactionEventSchema = z.object({
  type: z.enum(["reaction_added", "reaction_removed"]),
  user: routingStringSchema,
  reaction: routingStringSchema,
  item: z.object({
    type: z.string(),
    channel: routingStringSchema,
    ts: routingStringSchema,
  }),
  item_user: routingStringSchema.optional(),
  event_ts: routingStringSchema,
})
