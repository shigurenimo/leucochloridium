import { z } from "zod"

/**
 * Inbound port for Slack Socket Mode envelopes. The real implementation
 * (`LeucoFlumeSlackEventSource`) wraps `@interactive-inc/flume`; tests use
 * `LeucoMemorySlackEventSource` and call `emit(envelope)` directly. The
 * channel plugin depends only on this abstract class — flume types are not
 * exposed across the port.
 */
export abstract class LeucoSlackEventSource {
  abstract start(props: {
    onEvent: (envelope: LeucoSlackEnvelope) => Promise<void>
    onStatus?: (status: LeucoSlackSourceStatus) => void
    onLog?: (log: LeucoSlackSourceLog) => void
  }): Promise<void>

  abstract stop(): Promise<void>

  abstract status(): LeucoSlackSourceStatus
}

export type LeucoSlackEnvelope = {
  /** Slack Socket Mode envelope type: `"events_api"`, `"interactive"`, `"slash_commands"`, ... */
  type: string
  /** Raw envelope payload (e.g. `payload.event` for events_api). */
  payload: Record<string, unknown>
  receivedAt: number
}

/** Single source of truth for the four socket connection states. Re-used by
 * the `slack.connection` bus event so both stay in lockstep. */
export const leucoSlackSourceStatusSchema = z.enum([
  "disconnected",
  "connecting",
  "connected",
  "reconnecting",
])

export type LeucoSlackSourceStatus = z.infer<typeof leucoSlackSourceStatusSchema>

export type LeucoSlackSourceLog = {
  level: "debug" | "info" | "warn" | "error"
  action: string
  message: string
  error: Error | null
  detail: Record<string, unknown> | null
  timestamp: number
}
