import type { LeucoSettings } from "@/config/config-schema"
import type { Connector } from "@/connectors/connector"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import type { LeucoStore } from "@/storage/leuco-store"
import type { SlackCredentials } from "@/secrets/slack-credentials"

type Props = { settings: LeucoSettings; credentials: SlackCredentials | null; store: LeucoStore }

export function buildRuntimeConnections(props: Props): Connector[] {
  const connections: Connector[] = []
  const slack = props.settings.slack
  const credentials = props.credentials
  if (slack !== null && credentials !== null)
    connections.push(
      new LeucoSlackConnector({
        name: "slack",
        usesUserToken: credentials.botToken.startsWith("xoxp-"),
        ackMode: slack.ackMode,
        webClient: new LeucoFetchSlackWebClient({ botToken: credentials.botToken }),
        eventSource: new LeucoFlumeSlackEventSource({
          botToken: credentials.botToken,
          appToken: credentials.appToken,
        }),
      }),
    )
  connections.push(
    new LeucoScheduleConnector({
      name: "schedule",
      store: {
        listEntries: () => props.store.loadSettings().schedules,
        removeEntry: (id) =>
          props.store.updateSettings((settings) => ({
            ...settings,
            schedules: settings.schedules.filter((entry) => entry.id !== id),
          })),
        getLastFiredAt: (id) => props.store.loadState().scheduleLastFiredAt[id] ?? null,
        markFired: (id, timestamp) =>
          props.store.updateState((state) => ({
            ...state,
            scheduleLastFiredAt: { ...state.scheduleLastFiredAt, [id]: timestamp },
          })),
      },
    }),
  )
  return connections
}
