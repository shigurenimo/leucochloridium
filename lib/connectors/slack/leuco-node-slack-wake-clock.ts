import { LeucoSlackWakeClock } from "@/connectors/slack/leuco-slack-wake-clock"

export class LeucoNodeSlackWakeClock extends LeucoSlackWakeClock {
  constructor() {
    super()
    Object.freeze(this)
  }

  now(): number {
    return Date.now()
  }

  setInterval(handler: () => void, intervalMs: number): () => void {
    const handle = setInterval(handler, intervalMs)

    return () => clearInterval(handle)
  }
}
