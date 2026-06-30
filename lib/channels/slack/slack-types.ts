export type SlackMessageEvent = {
  kind: "message"
  channel: string
  user: string
  rawText: string
  text: string
  threadTs: string
  ts: string
  isThreadRoot: boolean
  mentioned: boolean
  source: "app_mention" | "message"
}

export type SlackReactionEvent = {
  kind: "reaction_added" | "reaction_removed"
  channel: string
  user: string
  emoji: string
  targetTs: string
  targetUser: string | null
}

export type SlackEvent = SlackMessageEvent | SlackReactionEvent

export type SlackMessage = SlackMessageEvent

export type SlackReply = {
  channel: string
  threadTs: string
  text: string
}
