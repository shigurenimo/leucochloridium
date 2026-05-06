import type { SlackEvent } from "@/channels/slack/slack-types"

/**
 * Structured events emitted by the daemon. Persisted as one JSON object per
 * line in `~/.leuco/daemon/events.jsonl`; subscribers (the gateway SSE feed,
 * the TUI, ad-hoc `tail | jq`) consume the same union.
 *
 * Every variant carries a `ts` (epoch milliseconds) and a discriminator
 * `type` so consumers can filter without reaching deeper into the payload.
 */
export type LeucoEvent =
  | { ts: number; type: "log"; level: "info" | "warn" | "error"; line: string }
  | { ts: number; type: "tenant.started"; project: string; agent: string }
  | { ts: number; type: "tenant.stopped"; project: string; agent: string }
  | { ts: number; type: "engine.reconcile"; added: string[]; removed: string[] }
  | {
      ts: number
      type: "slack.event"
      project: string
      agent: string
      channel: string
      event: SlackEvent
    }
  | {
      ts: number
      type: "turn.start"
      project: string
      agent: string
      threadKey: string
      input: string
    }
  | {
      ts: number
      type: "turn.complete"
      project: string
      agent: string
      threadKey: string
      reply: string
    }
  | {
      ts: number
      type: "turn.error"
      project: string
      agent: string
      threadKey: string
      error: string
    }
  | {
      ts: number
      type: "codex.notification"
      project: string
      agent: string
      method: string
      params: unknown
    }

export type LeucoEventListener = (event: LeucoEvent) => void
