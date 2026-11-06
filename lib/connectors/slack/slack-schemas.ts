import { z } from "zod"

const routingStringSchema = z.string().regex(/\S/, "Slack routing field must not be blank")

/** Subset of raw `app_mention` payload fields the listener actually needs. */
export const slackAppMentionPayloadSchema = z.object({
  channel: routingStringSchema,
  user: routingStringSchema.optional(),
  text: z.string().optional(),
  ts: routingStringSchema,
  thread_ts: routingStringSchema.optional(),
  bot_id: z.string().optional(),
})

/** Raw `message` payload, used as fallback when `app_mention` is not subscribed. */
export const slackMessagePayloadSchema = slackAppMentionPayloadSchema.extend({
  subtype: z.string().optional(),
})

/** Subset of raw `reaction_added` / `reaction_removed` payload fields we forward. */
export const slackReactionPayloadSchema = z.object({
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
