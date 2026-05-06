import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { Agent, Channel } from "@/config/config-schema"
import type { ChannelPlugin } from "@/engine/channel-plugin"

type BuildProps = {
  projectName: string
  agent: Agent
}

/**
 * Resolves an agent's `channels[]` entries into runtime `ChannelPlugin`
 * instances. Tokens live inline on each channel object (loaded from
 * `<projectDir>/settings.json`), so building plugins is a pure transform with
 * no extra IO.
 *
 * Returns `Error` on the first channel with empty tokens or unsupported type.
 */
export class LeucoChannelHost {
  private constructor() {
    Object.freeze(this)
  }

  static buildForAgent(props: BuildProps): ChannelPlugin[] | Error {
    const plugins: ChannelPlugin[] = []

    for (const channel of props.agent.channels) {
      const plugin = LeucoChannelHost.toPlugin({
        projectName: props.projectName,
        agentName: props.agent.name,
        channel,
      })
      if (plugin instanceof Error) return plugin
      plugins.push(plugin)
    }

    return plugins
  }

  private static toPlugin(props: {
    projectName: string
    agentName: string
    channel: Channel
  }): ChannelPlugin | Error {
    const { channel } = props
    const label = `${props.projectName}/${props.agentName}/${channel.name}`

    if (channel.type === "slack") {
      if (channel.botToken.length === 0) return new Error(`channel ${label}: botToken is empty`)
      if (channel.appToken.length === 0) return new Error(`channel ${label}: appToken is empty`)
      return new LeucoSlackChannelPlugin({
        name: channel.name,
        botToken: channel.botToken,
        appToken: channel.appToken,
        ackMode: channel.ackMode,
        ackIcons: channel.ackIcons,
      })
    }

    // Unreachable today (discriminated union has only "slack"); kept for future channel types.
    return new Error("unsupported channel type")
  }
}
