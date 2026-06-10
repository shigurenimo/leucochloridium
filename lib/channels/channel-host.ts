import { LeucoScheduleChannelPlugin } from "@/channels/schedule/schedule-channel-plugin"
import type { ScheduleStorePort } from "@/channels/schedule/schedule-store-port"
import { LeucoSlackChannelPlugin } from "@/channels/slack/slack-channel-plugin"
import { slackAppTokenSchema, slackBotTokenSchema } from "@/channels/slack/slack-schemas"
import type { Channel, ScheduleEntry } from "@/config/config-schema"
import type { ChannelPlugin } from "@/engine/channel-plugin"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"
import type { LeucoProjectStore } from "@/projects/project-store"

type ProjectRef = { id: string; name: string }

type BuildProps = {
  project: ProjectRef
  channels: Channel[]
  projectStore?: LeucoProjectStore
  projectStateStore?: LeucoProjectStateStore
}

/**
 * Resolves a project's `channels[]` entries into runtime `ChannelPlugin`
 * instances. Tokens live inline on each channel object (loaded from
 * `<projectDir>/settings.json`), so building plugins is a pure transform with
 * no extra IO.
 */
export class LeucoChannelHost {
  private constructor() {
    Object.freeze(this)
  }

  static buildForProject(props: BuildProps): ChannelPlugin[] {
    const plugins: ChannelPlugin[] = []
    for (const channel of props.channels) {
      plugins.push(
        LeucoChannelHost.toPlugin({
          project: props.project,
          channel,
          projectStore: props.projectStore,
          projectStateStore: props.projectStateStore,
        }),
      )
    }
    return plugins
  }

  private static toPlugin(props: {
    project: ProjectRef
    channel: Channel
    projectStore?: LeucoProjectStore
    projectStateStore?: LeucoProjectStateStore
  }): ChannelPlugin {
    const label = `${props.project.name}/${props.channel.name}`

    if (props.channel.type === "slack") {
      if (props.channel.botToken.length === 0) {
        throw new Error(`channel ${label}: botToken is empty`)
      }
      if (props.channel.appToken.length === 0) {
        throw new Error(`channel ${label}: appToken is empty`)
      }
      const botToken = slackBotTokenSchema.safeParse(props.channel.botToken)
      if (!botToken.success) {
        throw new Error(`channel ${label}: botToken ${botToken.error.issues[0]?.message}`)
      }
      const appToken = slackAppTokenSchema.safeParse(props.channel.appToken)
      if (!appToken.success) {
        throw new Error(`channel ${label}: appToken ${appToken.error.issues[0]?.message}`)
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
      if (!props.projectStateStore) {
        throw new Error(`channel ${label}: schedule channels require a projectStateStore`)
      }
      const store = buildScheduleStore({
        projectStore: props.projectStore,
        projectStateStore: props.projectStateStore,
        projectId: props.project.id,
        channelName: props.channel.name,
      })
      return new LeucoScheduleChannelPlugin({ name: props.channel.name, store })
    }

    throw new Error("unsupported channel type")
  }
}

const buildScheduleStore = (input: {
  projectStore: LeucoProjectStore
  projectStateStore: LeucoProjectStateStore
  projectId: string
  channelName: string
}): ScheduleStorePort => {
  return {
    listEntries(): ScheduleEntry[] {
      const project = input.projectStore.load(input.projectId)
      const channel = project.channels.find((c) => c.name === input.channelName)
      if (!channel) throw new Error(`channel '${input.channelName}' not found`)
      if (channel.type !== "schedule") {
        throw new Error(`channel '${input.channelName}' is not a schedule channel`)
      }
      return channel.entries
    },
    removeEntry(entryId: string): void {
      input.projectStore.removeScheduleEntry({
        projectId: input.projectId,
        channelName: input.channelName,
        entryIdOrName: entryId,
      })
    },
    getLastFiredAt(entryId: string): number | null {
      const state = input.projectStateStore.load(input.projectId)
      return state.scheduleLastFiredAt[entryId] ?? null
    },
    markFired(entryId: string, firedAt: number): void {
      input.projectStateStore.markScheduleEntryFired(input.projectId, entryId, firedAt)
    },
  }
}
