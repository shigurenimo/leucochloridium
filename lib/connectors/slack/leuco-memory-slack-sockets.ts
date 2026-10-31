import { LeucoSlackSockets } from "@/connectors/slack/leuco-slack-sockets"

export class LeucoMemorySlackSockets extends LeucoSlackSockets {
  readonly WebSocket = null
  closeCalls = 0
  forcedCloses = 0
  failure: Error | null = null

  async close(): Promise<number> {
    this.closeCalls += 1
    if (this.failure !== null) throw this.failure
    return this.forcedCloses
  }
}
