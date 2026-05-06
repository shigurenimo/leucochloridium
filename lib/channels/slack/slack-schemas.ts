import { z } from "zod"

export const slackBotTokenSchema = z.string().regex(/^xoxb-/, "must start with xoxb-")

export const slackAppTokenSchema = z.string().regex(/^xapp-/, "must start with xapp-")

/** Subset of `app_mention` event fields the listener actually needs. */
export const slackAppMentionEventSchema = z
  .object({
    channel: z.string(),
    user: z.string().optional(),
    text: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
  })
  .passthrough()

/** Subset of `message` event fields used as fallback when `app_mention` is not subscribed. */
export const slackMessageEventSchema = z
  .object({
    channel: z.string(),
    user: z.string().optional(),
    text: z.string().optional(),
    ts: z.string(),
    thread_ts: z.string().optional(),
    subtype: z.string().optional(),
    bot_id: z.string().optional(),
  })
  .passthrough()

export const slackAuthTestSchema = z
  .object({
    user_id: z.string().optional(),
  })
  .passthrough()

/** Subset of `reaction_added` / `reaction_removed` event fields we forward. */
export const slackReactionEventSchema = z
  .object({
    type: z.enum(["reaction_added", "reaction_removed"]),
    user: z.string(),
    reaction: z.string(),
    item: z
      .object({
        type: z.string(),
        channel: z.string(),
        ts: z.string(),
      })
      .passthrough(),
    item_user: z.string().optional(),
    event_ts: z.string(),
  })
  .passthrough()
