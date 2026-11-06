import type { LeucoSlackWebClient } from "@/connectors/slack/leuco-slack-web-client"
import { errorMessage } from "@/error-message"

type LeucoSlackAdapterProps = {
  client: LeucoSlackWebClient
}

/**
 * Connector acknowledgement reactions; message sends use explicit Slack CLI actions.
 * Failures resolve to an Error instead of throwing so the caller can record them
 * against the request that triggered the reaction.
 */
export class LeucoSlackAdapter {
  constructor(private readonly props: LeucoSlackAdapterProps) {
    Object.freeze(this)
  }

  async addReaction(channel: string, ts: string, name: string): Promise<Error | null> {
    try {
      await this.props.client.reactionsAdd({ channel, timestamp: ts, name })
      return null
    } catch (err) {
      return toReactionFailure(err)
    }
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<Error | null> {
    try {
      await this.props.client.reactionsRemove({ channel, timestamp: ts, name })
      return null
    } catch (err) {
      return toReactionFailure(err)
    }
  }
}

// Idempotent reactions (`already_reacted`) are expected; everything else
// (invalid_auth, missing_scope, channel_not_found, ratelimited, …) is returned
// so a silently-revoked bot token doesn't manifest as the ack icons just
// quietly disappearing.
const toReactionFailure = (err: unknown): Error | null => {
  if (/already_reacted|no_reaction|message_not_found/i.test(errorMessage(err))) return null
  return err instanceof Error ? err : new Error(errorMessage(err))
}
