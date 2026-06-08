import { App, LogLevel } from "@slack/bolt"
import { LeucoSlackEventProcessor } from "@/channels/slack/slack-event-processor"
import { slackAuthTestSchema } from "@/channels/slack/slack-schemas"
import type { SlackEvent } from "@/channels/slack/slack-types"
import { errorMessage } from "@/error-message"

type EventHandler = (event: SlackEvent) => void | Promise<void>

type Props = {
  botToken: string
  appToken: string
  onLog?: (line: string) => void
}

/**
 * Slack Socket Mode listener. Owns the bolt `App` lifecycle; delegates all
 * decision logic (schema check, dedup, self filter) to
 * `LeucoSlackEventProcessor`. Forwards messages and reaction events to the
 * bridge as a `SlackEvent` union — the agent decides whether to respond.
 */
export class LeucoSlackListener {
  private readonly app: App
  private readonly onLog: ((line: string) => void) | undefined
  private handler: EventHandler | null = null
  // Wire the processor at construction so events arriving in the
  // `app.start()`→`fetchBotUserId()` window aren't silently dropped. The
  // botUserId starts null (causing self/bot filters to skip those events
  // until known) and is upgraded once auth.test resolves.
  private processor: LeucoSlackEventProcessor
  private botUserId: string | null = null

  constructor(props: Props) {
    this.onLog = props.onLog
    this.app = new App({
      token: props.botToken,
      appToken: props.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    })
    this.processor = new LeucoSlackEventProcessor({ botUserId: null })
    this.bindEvents()
  }

  onEvent(handler: EventHandler): void {
    this.handler = handler
  }

  async start(): Promise<{ botUserId: string | null }> {
    await this.app.start()
    this.botUserId = await this.fetchBotUserId()
    // Upgrade the processor in place — mutating preserves the LRU dedup
    // window that may already hold ids from events that arrived during the
    // `app.start()` → `auth.test` race. Rebuilding would drop those keys and
    // let an early redelivery dispatch twice.
    this.processor.setBotUserId(this.botUserId)
    return { botUserId: this.botUserId }
  }

  async stop(): Promise<void> {
    await this.app.stop()
  }

  private async fetchBotUserId(): Promise<string | null> {
    try {
      const auth = await this.app.client.auth.test()
      const parsed = slackAuthTestSchema.safeParse(auth)
      return parsed.success ? (parsed.data.user_id ?? null) : null
    } catch (err) {
      this.log(`auth.test failed: ${errorMessage(err)}`)
      return null
    }
  }

  private bindEvents(): void {
    this.app.event("app_mention", async (args) => {
      await this.dispatchResult(this.processor.processAppMention(args.event))
    })

    this.app.message(async (args) => {
      await this.dispatchResult(this.processor.processMessage(args.message))
    })

    this.app.event("reaction_added", async (args) => {
      await this.dispatchResult(this.processor.processReaction(args.event))
    })

    this.app.event("reaction_removed", async (args) => {
      await this.dispatchResult(this.processor.processReaction(args.event))
    })

    this.app.error(async (err) => {
      this.log(`bolt error: ${errorMessage(err)}`)
    })
  }

  private async dispatchResult(
    result: ReturnType<LeucoSlackEventProcessor["processMessage"]>,
  ): Promise<void> {
    if (result.skip) {
      this.log(result.reason)
      return
    }
    if (!this.handler) {
      this.log("no handler registered; dropping event")
      return
    }
    this.log(formatDispatch(result.event))
    await this.handler(result.event)
  }

  private log(line: string): void {
    if (this.onLog) this.onLog(`[slack] ${line}`)
  }
}

const formatDispatch = (event: SlackEvent): string => {
  if (event.kind === "message") {
    return `dispatch ${event.source} channel=${event.channel} ts=${event.ts}${event.mentioned ? " mentioned" : ""}`
  }
  return `dispatch ${event.kind} channel=${event.channel} target_ts=${event.targetTs} :${event.emoji}: by=${event.user}`
}
