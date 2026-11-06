import type { ReceptionRules } from "@/config/config-schema"
import { acceptsReception } from "@/connectors/accepts-reception"
import type { SlackEvent } from "@/connectors/slack/slack-types"

type Props = { event: SlackEvent; reception: ReceptionRules; participating: boolean }

/** Slackのイベントを共通の受付種別へ写す。Dで始まるchannelはDMとして扱う。 */
export function acceptsSlackEvent(props: Props): boolean {
  const event = props.event
  const target = { rules: props.reception, channel: event.channel, user: event.user }
  if (event.kind !== "message")
    return acceptsReception({ ...target, kind: event.kind, emoji: event.emoji })
  const kind = event.channel.startsWith("D")
    ? "dm"
    : event.mentioned || event.source === "app_mention"
      ? "mention"
      : props.participating
        ? "thread"
        : "message"
  return acceptsReception({ ...target, kind })
}
