export type DiscordEnvelope = {
  type: string
  data: Readonly<Record<string, unknown>>
  receivedAt: number
}
export type DiscordSourceHandlers = {
  onEvent: (event: DiscordEnvelope) => Promise<void>
  onLog: (message: string) => void
  onStatus: (state: string) => void
}

export abstract class DiscordEventSource {
  abstract start(handlers: DiscordSourceHandlers): Promise<void>
  abstract stop(): Promise<void>
  abstract status(): string
}
