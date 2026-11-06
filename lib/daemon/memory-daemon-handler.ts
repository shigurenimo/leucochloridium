import { handleDaemonRequest } from "@/daemon/handle-daemon-request"
import { reportDaemonRequestFailure } from "@/daemon/report-daemon-request-failure"
import { LeucoEventLog } from "@/events/leuco-event-log"

type Props = {
  token: string
  secrets: string[]
  overrides?: Partial<Parameters<typeof handleDaemonRequest>[0]>
}

/** Test handler whose collaborators succeed unless overridden; failures go to an in-memory log. */
export function createMemoryDaemonHandler(props: Props) {
  const log = new LeucoEventLog()
  log.addRedactionSecrets(props.secrets)
  const handler = handleDaemonRequest({
    token: props.token,
    cwd: "/work",
    isReady: () => true,
    getVolatileEvents: () => [],
    getMaintenance: () => null,
    getRuntimeStatus: () => ({}),
    restart: () => ({}),
    runTextTurn: async () => "",
    runDiscordCommand: async () => ({}),
    runSlackCommand: async () => ({}),
    stop: () => {},
    awaitStop: async () => {},
    ownsProcess: false,
    reportError: (error, requestId) => reportDaemonRequestFailure(log, error, requestId),
    redactText: (text) => log.redactText(text),
    ...props.overrides,
  })
  return { handler, log }
}
