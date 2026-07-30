export abstract class LeucoSlackWakeClock {
  abstract now(): number

  abstract setInterval(handler: () => void, intervalMs: number): () => void
}
