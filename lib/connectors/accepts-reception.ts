import type { ReceptionRules } from "@/config/config-schema"

type Target = { rules: ReceptionRules; channel: string; user: string }

export type ReceptionProps =
  | (Target & { kind: "dm" | "mention" | "thread" | "message" })
  | (Target & { kind: "reaction_added" | "reaction_removed"; emoji: string })

/** Slack・Discord共通の受付判定。モデル呼び出し前に行い、拒否指定を許可指定より優先する。 */
export function acceptsReception(props: ReceptionProps): boolean {
  const rules = props.rules
  if (rules.deniedChannels.includes(props.channel) || rules.deniedUsers.includes(props.user))
    return false
  if (rules.allowedChannels !== null && !rules.allowedChannels.includes(props.channel)) return false
  if (rules.allowedUsers !== null && !rules.allowedUsers.includes(props.user)) return false
  if (props.kind === "reaction_added") return rules.reactionAdded.includes(props.emoji)
  if (props.kind === "reaction_removed") return rules.reactionRemoved.includes(props.emoji)
  if (props.kind === "dm") return rules.directMessages
  if (props.kind === "mention") return rules.mentions
  if (props.kind === "thread") return rules.participatingThreads
  return rules.channelMessages
}
