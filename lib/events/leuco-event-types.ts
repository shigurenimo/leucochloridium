import type { z } from "zod"
import type { leucoEventSchema } from "@/events/leuco-event-schema"

/**
 * Structured events emitted by the daemon. Persisted as one JSON object per
 * line in `~/.leuco/daemon/events.jsonl`; subscribers (the gateway SSE feed,
 * `leuco logs -f`, ad-hoc `tail | jq`) consume the same union.
 *
 * Every variant carries a `ts` (epoch milliseconds) and a discriminator
 * `type` so consumers can filter without reaching deeper into the payload.
 */
export type LeucoEvent = z.infer<typeof leucoEventSchema>

export type LeucoEventListener = (event: LeucoEvent) => void
