import type { DiscordReception } from "@/config/config-schema"
import { acceptsReception, type ReceptionProps } from "@/connectors/accepts-reception"

type Props = ReceptionProps & { rules: DiscordReception; guild: string | null }

/** DMにもチャンネル・ユーザー制限を適用し、サーバー制限はサーバー内だけに適用する。 */
export function acceptsDiscordEvent(props: Props): boolean {
  const rules = props.rules
  const guild = props.guild
  if (
    guild !== null &&
    (rules.deniedGuilds.includes(guild) ||
      (rules.allowedGuilds !== null && !rules.allowedGuilds.includes(guild)))
  )
    return false
  return acceptsReception(props)
}
