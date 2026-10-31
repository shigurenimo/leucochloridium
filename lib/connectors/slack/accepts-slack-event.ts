import type { SlackReception } from "@/config/config-schema"
import type { SlackEvent } from "@/connectors/slack/slack-types"

type Props = { event: SlackEvent; reception: SlackReception; participating: boolean }

/** 許可範囲とイベント種別を、モデル呼び出し前に判定する。拒否指定を優先する。 */
export function acceptsSlackEvent(props: Props): boolean {
  const event = props.event
  const rules = props.reception
  if (rules.deniedChannels.includes(event.channel) || rules.deniedUsers.includes(event.user))
    return false
  if (rules.allowedChannels !== null && !rules.allowedChannels.includes(event.channel)) return false
  if (rules.allowedUsers !== null && !rules.allowedUsers.includes(event.user)) return false
  if (event.kind === "reaction_added") return rules.reactionAdded.includes(event.emoji)
  if (event.kind === "reaction_removed") return rules.reactionRemoved.includes(event.emoji)
  if (event.kind !== "message") return false
  if (event.channel.startsWith("D")) return rules.directMessages
  if (event.mentioned || event.source === "app_mention") return rules.mentions
  if (props.participating) return rules.participatingThreads
  return rules.channelMessages
}
