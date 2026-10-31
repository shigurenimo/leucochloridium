import type { DiscordReception } from "@/config/config-schema"

type Props = {
  rules: DiscordReception
  channel: string
  guild: string | null
  user: string
  kind: "dm" | "mention" | "thread" | "message" | "reaction_added" | "reaction_removed"
  emoji?: string
}

/** DMにもチャンネル・ユーザー制限を適用し、サーバー制限はサーバー内だけに適用する。 */
export function acceptsDiscordEvent(props: Props): boolean {
  const rules = props.rules
  if (rules.deniedChannels.includes(props.channel) || rules.deniedUsers.includes(props.user))
    return false
  if (rules.allowedChannels !== null && !rules.allowedChannels.includes(props.channel)) return false
  if (rules.allowedUsers !== null && !rules.allowedUsers.includes(props.user)) return false
  if (
    props.guild !== null &&
    (rules.deniedGuilds.includes(props.guild) ||
      (rules.allowedGuilds !== null && !rules.allowedGuilds.includes(props.guild)))
  )
    return false
  if (props.kind === "dm") return rules.directMessages
  if (props.kind === "mention") return rules.mentions
  if (props.kind === "thread") return rules.participatingThreads
  if (props.kind === "reaction_added") return rules.reactionAdded.includes(props.emoji ?? "")
  if (props.kind === "reaction_removed") return rules.reactionRemoved.includes(props.emoji ?? "")
  return rules.channelMessages
}
