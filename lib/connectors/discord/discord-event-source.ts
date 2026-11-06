import type { LogLevel } from "@/log-level"

export type DiscordEnvelope = {
  type: string
  data: Readonly<Record<string, unknown>>
  receivedAt: number
}
export type DiscordSourceLog = {
  level: LogLevel
  action: string
  message: string
  error: Error | null
}
export type DiscordSourceHandlers = {
  /** Resolves once the event is handed off, not when its turn ends; sources await it to keep arrival order. */
  onEvent: (event: DiscordEnvelope) => Promise<void>
  onLog: (log: DiscordSourceLog) => void
  onStatus: (state: string) => void
}

export abstract class DiscordEventSource {
  abstract start(handlers: DiscordSourceHandlers): Promise<void>
  abstract stop(): Promise<void>
  abstract status(): string
}
