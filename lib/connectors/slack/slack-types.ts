import type { z } from "zod"
import type {
  slackEventSchema,
  slackMessageEventSchema,
  slackReactionEventSchema,
} from "@/connectors/slack/slack-event-schema"

export type SlackMessageEvent = z.infer<typeof slackMessageEventSchema>
export type SlackReactionEvent = z.infer<typeof slackReactionEventSchema>
export type SlackEvent = z.infer<typeof slackEventSchema>
