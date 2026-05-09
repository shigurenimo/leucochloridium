import { z } from "zod"

const slackMessageEventSchema = z.object({
  kind: z.literal("message"),
  channel: z.string(),
  user: z.string(),
  rawText: z.string(),
  text: z.string(),
  threadTs: z.string(),
  ts: z.string(),
  isThreadRoot: z.boolean(),
  mentioned: z.boolean(),
  source: z.enum(["app_mention", "message"]),
})

const slackReactionEventSchema = z.object({
  kind: z.enum(["reaction_added", "reaction_removed"]),
  channel: z.string(),
  user: z.string(),
  emoji: z.string(),
  targetTs: z.string(),
  targetUser: z.string().nullable(),
})

export const slackEventSchema = z.discriminatedUnion("kind", [
  slackMessageEventSchema,
  slackReactionEventSchema,
])
