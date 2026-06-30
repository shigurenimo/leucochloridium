import {
  type LeucoSlackEnvelope,
  LeucoSlackEventSource,
  type LeucoSlackSourceLog,
  type LeucoSlackSourceStatus,
} from "@/channels/slack/leuco-slack-event-source"

/**
 * In-memory test double for `LeucoSlackEventSource`. After `start(...)`, the
 * test drives traffic with `emit(envelope)`, `setStatus(status)`, and `log({...})`.
 */
export class LeucoMemorySlackEventSource extends LeucoSlackEventSource {
  private onEvent: ((envelope: LeucoSlackEnvelope) => Promise<void>) | null = null
  private onStatus: ((status: LeucoSlackSourceStatus) => void) | null = null
  private onLog: ((log: LeucoSlackSourceLog) => void) | null = null
  private currentStatus: LeucoSlackSourceStatus = "disconnected"

  async start(props: {
    onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>
    onStatus?: (status: LeucoSlackSourceStatus) => void
    onLog?: (log: LeucoSlackSourceLog) => void
  }): Promise<void> {
    this.onEvent = props.onEvent
    this.onStatus = props.onStatus ?? null
    this.onLog = props.onLog ?? null
    this.setStatus("connected")
  }

  async stop(): Promise<void> {
    this.onEvent = null
    this.setStatus("disconnected")
    this.onStatus = null
    this.onLog = null
  }

  status(): LeucoSlackSourceStatus {
    return this.currentStatus
  }

  async emit(envelope: LeucoSlackEnvelope): Promise<void> {
    const handler = this.onEvent
    if (handler === null) return
    await handler(envelope)
  }

  setStatus(status: LeucoSlackSourceStatus): void {
    this.currentStatus = status
    if (this.onStatus !== null) this.onStatus(status)
  }

  log(entry: LeucoSlackSourceLog): void {
    if (this.onLog !== null) this.onLog(entry)
  }
}
