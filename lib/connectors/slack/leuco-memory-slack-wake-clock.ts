import { LeucoSlackWakeClock } from "@/connectors/slack/leuco-slack-wake-clock"

export class LeucoMemorySlackWakeClock extends LeucoSlackWakeClock {
  private readonly handlers = new Set<() => void>()
  private currentTimeMs = 0
  private clearCount = 0

  now(): number {
    return this.currentTimeMs
  }

  setInterval(handler: () => void, intervalMs: number): () => void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("intervalMs must be a positive integer")
    }
    this.handlers.add(handler)

    return () => {
      if (this.handlers.delete(handler)) this.clearCount += 1
    }
  }

  advance(elapsedMs: number): void {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new Error("elapsedMs must be a non-negative integer")
    }
    this.currentTimeMs += elapsedMs
    for (const handler of this.handlers) handler()
  }

  clearCalls(): number {
    return this.clearCount
  }
}
