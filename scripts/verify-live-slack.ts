import { leucoHomeSchema } from "@/config/leuco-home-schema"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { BunCredentialStore } from "@/secrets/bun-credential-store"
import { loadSlackCredentials } from "@/secrets/load-slack-credentials"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { errorDetails } from "@/error-details"

/** Explicit live check only: authenticates and receives socket events, never runs an agent or posts messages. */
const home = leucoHomeSchema.parse(process.env.LEUCO_HOME)
const events = new LeucoEventLog()
const resources: {
  source: LeucoFlumeSlackEventSource | null
  identity: { userId: string | null; botId?: string | null } | null
  connected: boolean
} = { source: null, identity: null, connected: false }
const failures: unknown[] = []
const deadlineState: { expired: boolean; exitTimer: ReturnType<typeof setTimeout> | null } = {
  expired: false,
  exitTimer: null,
}
const watchdog = setTimeout(() => {
  deadlineState.expired = true
  process.stderr.write(
    '{"ok":false,"error":"Live Slack verification exceeded 30 seconds; inspect credential-store access and connectivity"}\n',
  )
  void resources.source?.stop().catch((error: unknown) => {
    failures.push(error)
  })
  deadlineState.exitTimer = setTimeout(() => process.exit(1), 1000)
}, 30000)
try {
  const slack = new NodeLeucoStore(home).loadSettings().slack
  if (slack === null)
    throw new Error(
      "Copy each token separately and run leuco slack login bot / leuco slack login app first",
    )
  const credentials = await loadSlackCredentials(new BunCredentialStore(), slack.credential)
  events.setRedactionSecrets([credentials.botToken, credentials.appToken])
  resources.identity = await new LeucoFetchSlackWebClient({
    botToken: credentials.botToken,
  }).authTest()
  const source = new LeucoFlumeSlackEventSource({ ...credentials, startTimeoutMs: 15000 })
  resources.source = source
  await source.start({
    onEvent: async () => {},
    onLog: (entry) => {
      if (entry.level === "error") events.error(entry.message, entry.error)
    },
  })
  const deadline = Date.now() + 5000
  while (source.status() !== "connected" && Date.now() < deadline) await Bun.sleep(50)
  if (source.status() !== "connected")
    throw new Error(`Slack socket did not become connected; observed ${source.status()}`)
  resources.connected = true
} catch (error) {
  failures.push(error)
} finally {
  try {
    await resources.source?.stop()
  } catch (error) {
    failures.push(error)
  }
  clearTimeout(watchdog)
  if (deadlineState.exitTimer !== null) clearTimeout(deadlineState.exitTimer)
}
if (deadlineState.expired) {
  process.exitCode = 1
} else if (failures.length > 0) {
  process.stderr.write(
    `${events.redactText(JSON.stringify({ ok: false, causes: errorDetails(new AggregateError(failures, "Live Slack verification failed")), recentErrors: events.query({ type: "log", limit: 10 }) }))}\n`,
  )
  process.exitCode = 1
} else
  process.stdout.write(
    `${JSON.stringify({ ok: true, identity: resources.identity, socketConnected: resources.connected, agentTurns: 0, chatPosts: 0 })}\n`,
  )
events.close()
