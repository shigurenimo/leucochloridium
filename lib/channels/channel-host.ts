import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { Agent, Channel, ScheduleEntry } from "@/config/config-schema"
import type { ChannelPlugin } from "@/engine/channel-plugin"
import type { LeucoProjectStore } from "@/projects/project-store"

type BuildProps = {
  projectName: string
  agent: Agent
  /**
   * Required only when the agent has at least one schedule channel — the
   * plugin needs to re-read entries every tick and delete fired one-shots.
   * Slack-only agents pass nothing.
   */
  projectStore?: LeucoProjectStore
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
        projectStore: props.projectStore,
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
    projectStore?: LeucoProjectStore
  }): ChannelPlugin | Error {
    const label = `${props.projectName}/${props.agentName}/${props.channel.name}`

    if (props.channel.type === "slack") {
      if (props.channel.botToken.length === 0)
        return new Error(`channel ${label}: botToken is empty`)
      if (props.channel.appToken.length === 0)
        return new Error(`channel ${label}: appToken is empty`)
      return new LeucoSlackChannelPlugin({
        name: props.channel.name,
        botToken: props.channel.botToken,
        appToken: props.channel.appToken,
        ackMode: props.channel.ackMode,
        ackIcons: props.channel.ackIcons,
      })
    }

    if (props.channel.type === "schedule") {
      if (!props.projectStore) {
        return new Error(`channel ${label}: schedule channels require a projectStore`)
      }
      const store = buildScheduleStore({
        projectStore: props.projectStore,
        projectName: props.projectName,
        agentName: props.agentName,
        channelName: props.channel.name,
      })
      return new LeucoScheduleChannelPlugin({ name: props.channel.name, store })
    }

    return new Error("unsupported channel type")
  }
}

const buildScheduleStore = (input: {
  projectStore: LeucoProjectStore
  projectName: string
  agentName: string
  channelName: string
}): ScheduleStorePort => {
  return {
    listEntries(): ScheduleEntry[] | Error {
      const project = input.projectStore.load(input.projectName)
      if (project instanceof Error) return project
      const agent = project.agents.find((a) => a.name === input.agentName)
      if (!agent) return new Error(`agent '${input.agentName}' not found`)
      const channel = agent.channels.find((c) => c.name === input.channelName)
      if (!channel) return new Error(`channel '${input.channelName}' not found`)
      if (channel.type !== "schedule") {
        return new Error(`channel '${input.channelName}' is not a schedule channel`)
      }
      return channel.entries
    },
    removeEntry(entryId: string): void | Error {
      const result = input.projectStore.removeScheduleEntry({
        projectName: input.projectName,
        agentName: input.agentName,
        channelName: input.channelName,
        entryIdOrName: entryId,
      })
      if (result instanceof Error) return result
    },
  }
}
