export type {
  SlackEvent,
  SlackMessageEvent,
  SlackReactionEvent,
} from "@interactive-inc/claude-funnel/connectors/slack"

export type SlackMessage =
  import("@interactive-inc/claude-funnel/connectors/slack").SlackMessageEvent

export type SlackReply = {
  channel: string
  threadTs: string
  text: string
}
