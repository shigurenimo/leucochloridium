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
        ackMode: slack.ackMode,
        webClient: new LeucoFetchSlackWebClient({ botToken: credentials.botToken }),
        eventSource: new LeucoFlumeSlackEventSource({
          botToken: credentials.botToken,
          appToken: credentials.appToken,
        }),
      }),
    )
  const attempts: {
    snapshot: { fired: Record<string, number>; scheduled: Record<string, string> } | null
  } = { snapshot: null }
  connections.push(
    new LeucoScheduleConnector({
      store: {
        listEntries: () => {
          attempts.snapshot = null
          return props.store.loadSettings().schedules
        },
        removeEntry: (id, expectedRunAt) => {
          const removal = { removed: false }
          props.store.updateSettings((settings) => {
            const schedules = settings.schedules.filter(
              (entry) => entry.id !== id || entry.runAt !== expectedRunAt,
            )
            removal.removed = schedules.length < settings.schedules.length
            return { ...settings, schedules }
          })
          return removal.removed
        },
        getLastAttempt: (id) => {
          if (attempts.snapshot === null) {
            const state = props.store.loadState()
            attempts.snapshot = {
              fired: state.scheduleLastFiredAt,
              scheduled: state.scheduleLastRunAt ?? {},
            }
          }
          const snapshot = attempts.snapshot
          const timestamp = Object.hasOwn(snapshot.fired, id) ? snapshot.fired[id] : undefined
          if (timestamp === undefined) return null
          const scheduledTimes = snapshot.scheduled
          return {
            firedAt: timestamp,
            runAt: Object.hasOwn(scheduledTimes, id) ? (scheduledTimes[id] ?? null) : null,
          }
        },
        markFired: (id, timestamp, runAt) => {
          attempts.snapshot = null
          props.store.updateState((state) => ({
            ...state,
            scheduleLastFiredAt: { ...state.scheduleLastFiredAt, [id]: timestamp },
            scheduleLastRunAt: { ...state.scheduleLastRunAt, [id]: runAt },
          }))
        },
      },
    }),
  )
  return connections
}
