import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import type { Agent, Channel, ScheduleEntry } from "@/config/config-schema"
import type { ChannelPlugin } from "@/engine/channel-plugin"
import type { LeucoProjectStore } from "@/projects/project-store"

type ProjectRef = { id: string; name: string }

type BuildProps = {
  project: ProjectRef
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
 * Throws on the first channel with empty tokens or unsupported type.
 */
export class LeucoChannelHost {
  private constructor() {
    Object.freeze(this)
  }

  static buildForAgent(props: BuildProps): ChannelPlugin[] {
    const plugins: ChannelPlugin[] = []
    for (const channel of props.agent.channels) {
      plugins.push(
        LeucoChannelHost.toPlugin({
          project: props.project,
          agentName: props.agent.name,
          channel,
          projectStore: props.projectStore,
        }),
      )
    }
    return plugins
  }

  private static toPlugin(props: {
    project: ProjectRef
    agentName: string
    channel: Channel
    projectStore?: LeucoProjectStore
  }): ChannelPlugin {
    const label = `${props.project.name}/${props.agentName}/${props.channel.name}`

    if (props.channel.type === "slack") {
      if (props.channel.botToken.length === 0) {
        throw new Error(`channel ${label}: botToken is empty`)
      }
      if (props.channel.appToken.length === 0) {
        throw new Error(`channel ${label}: appToken is empty`)
      }
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
        throw new Error(`channel ${label}: schedule channels require a projectStore`)
      }
      const store = buildScheduleStore({
        projectStore: props.projectStore,
        projectId: props.project.id,
        agentName: props.agentName,
        channelName: props.channel.name,
      })
      return new LeucoScheduleChannelPlugin({ name: props.channel.name, store })
    }

    throw new Error("unsupported channel type")
  }
}

const buildScheduleStore = (input: {
  projectStore: LeucoProjectStore
  projectId: string
  agentName: string
  channelName: string
}): ScheduleStorePort => {
  return {
    listEntries(): ScheduleEntry[] {
      const project = input.projectStore.load(input.projectId)
      const agent = project.agents.find((a) => a.name === input.agentName)
      if (!agent) throw new Error(`agent '${input.agentName}' not found`)
      const channel = agent.channels.find((c) => c.name === input.channelName)
      if (!channel) throw new Error(`channel '${input.channelName}' not found`)
      if (channel.type !== "schedule") {
        throw new Error(`channel '${input.channelName}' is not a schedule channel`)
      }
      return channel.entries
    },
    removeEntry(entryId: string): void {
      input.projectStore.removeScheduleEntry({
        projectId: input.projectId,
        agentName: input.agentName,
        channelName: input.channelName,
        entryIdOrName: entryId,
      })
    },
  }
}
