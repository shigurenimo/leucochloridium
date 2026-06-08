import type { z } from "zod"
import type { leucoEventSchema } from "@/events/leuco-event-schema"

export type LeucoEvent = z.infer<typeof leucoEventSchema>

export type LeucoEventListener = (event: LeucoEvent) => void
