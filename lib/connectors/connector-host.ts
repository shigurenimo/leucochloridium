import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import type { ScheduleStorePort } from "@/connectors/schedule/schedule-store-port"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { slackAppTokenSchema, slackBotTokenSchema } from "@/connectors/slack/slack-schemas"
import type { ConnectorConfig, ScheduleEntry } from "@/config/config-schema"
import type { Connector } from "@/connectors/connector"
import type { LeucoProjectStateStore } from "@/projects/project-state-store"
import type { LeucoProjectStore } from "@/projects/project-store"

export type LeucoProjectRef = { id: string; name: string }

export type LeucoConnectorHostBuildProps = {
  project: LeucoProjectRef
  connectors: ConnectorConfig[]
  projectStore?: LeucoProjectStore
  projectStateStore?: LeucoProjectStateStore
}

/**
 * Resolves a project's `connectors[]` entries into runtime `Connector`
 * instances. Tokens live inline on each connector object loaded from unified
 * settings, so building connectors is a pure transform with no extra IO.
 */
export class LeucoConnectorHost {
  private constructor() {
    Object.freeze(this)
  }

  static buildForProject(props: LeucoConnectorHostBuildProps): Connector[] {
    const connectors: Connector[] = []
    for (const connector of props.connectors) {
      connectors.push(
        LeucoConnectorHost.buildConnector({
          project: props.project,
          connector,
          projectStore: props.projectStore,
          projectStateStore: props.projectStateStore,
        }),
      )
    }
    return connectors
  }

  static buildConnector(props: {
    project: LeucoProjectRef
    connector: ConnectorConfig
    projectStore?: LeucoProjectStore
    projectStateStore?: LeucoProjectStateStore
  }): Connector {
    const label = `${props.project.name}/${props.connector.name}`

    if (props.connector.type === "slack") {
      if (props.connector.botToken.length === 0) {
        throw new Error(`connector ${label}: botToken is empty`)
      }
      if (props.connector.appToken.length === 0) {
        throw new Error(`connector ${label}: appToken is empty`)
      }
      const botToken = slackBotTokenSchema.safeParse(props.connector.botToken)
      if (!botToken.success) {
        throw new Error(`connector ${label}: botToken ${botToken.error.issues[0]?.message}`)
      }
      const appToken = slackAppTokenSchema.safeParse(props.connector.appToken)
      if (!appToken.success) {
        throw new Error(`connector ${label}: appToken ${appToken.error.issues[0]?.message}`)
      }
      const webClient = new LeucoFetchSlackWebClient({ botToken: props.connector.botToken })
      const eventSource = new LeucoFlumeSlackEventSource({
        botToken: props.connector.botToken,
        appToken: props.connector.appToken,
      })

      return new LeucoSlackConnector({
        name: props.connector.name,
        eventSource,
        webClient,
        usesUserToken: props.connector.botToken.startsWith("xoxp-"),
        ackMode: props.connector.ackMode,
        ackIcons: props.connector.ackIcons,
      })
    }

    if (props.connector.type === "schedule") {
      if (!props.projectStore) {
        throw new Error(`connector ${label}: schedule connectors require a projectStore`)
      }
      if (!props.projectStateStore) {
        throw new Error(`connector ${label}: schedule connectors require a projectStateStore`)
      }
      const store = buildScheduleStore({
        projectStore: props.projectStore,
        projectStateStore: props.projectStateStore,
        projectId: props.project.id,
        connectorName: props.connector.name,
      })
      return new LeucoScheduleConnector({ name: props.connector.name, store })
    }

    throw new Error("unsupported connector type")
  }
}

const buildScheduleStore = (input: {
  projectStore: LeucoProjectStore
  projectStateStore: LeucoProjectStateStore
  projectId: string
  connectorName: string
}): ScheduleStorePort => {
  return {
    listEntries(): ScheduleEntry[] {
      const project = input.projectStore.load(input.projectId)
      const connector = project.connectors.find((c) => c.name === input.connectorName)
      if (!connector) throw new Error(`connector '${input.connectorName}' not found`)
      if (connector.type !== "schedule") {
        throw new Error(`connector '${input.connectorName}' is not a schedule connector`)
      }
      return connector.entries
    },
    removeEntry(entryId: string): void {
      input.projectStore.removeScheduleEntry({
        projectId: input.projectId,
        connectorName: input.connectorName,
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
