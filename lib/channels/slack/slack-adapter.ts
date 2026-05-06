import { WebClient } from "@slack/web-api"
import type { SlackReply } from "@/channels/slack/slack-types"
import type { WebClientPort } from "@/channels/slack/web-client-port"

type Props = {
  client: WebClientPort
}

/** Thin wrapper around `chat.postMessage` for thread replies and ephemeral status updates. */
export class LeucoSlackAdapter {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  static fromBotToken(botToken: string): LeucoSlackAdapter {
    return new LeucoSlackAdapter({ client: new WebClient(botToken) })
  }

  async postReply(reply: SlackReply): Promise<void> {
    await this.props.client.chat.postMessage({
      channel: reply.channel,
      thread_ts: reply.threadTs,
      text: reply.text,
    })
  }

  async addReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.props.client.reactions.add({ channel, timestamp: ts, name })
    } catch {
      // reactions.add is non-critical; ignore failures (already_reacted etc.)
    }
  }

  async removeReaction(channel: string, ts: string, name: string): Promise<void> {
    try {
      await this.props.client.reactions.remove({ channel, timestamp: ts, name })
    } catch {
      // idempotent best-effort
    }
  }
}
