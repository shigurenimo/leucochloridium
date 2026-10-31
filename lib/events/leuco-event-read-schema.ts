import { z } from "zod"
import { leucoEventSchema } from "@/events/leuco-event-schema"

const legacyEnvelopeSchema = z
  .object({
    type: z.string(),
    runtime: z.string().optional(),
    project: z.string().optional(),
    channel: z.string().optional(),
    connector: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough()

const LEGACY_EVENT_TYPES: Readonly<Record<string, string>> = {
  "tenant.started": "runtime.started",
  "tenant.stopped": "runtime.stopped",
  "engine.reconcile": "supervisor.reconcile",
  "engine.reconcile.failed": "supervisor.reconcile.failed",
}

export const leucoEventReadSchema = z.preprocess((value) => {
  const parsed = legacyEnvelopeSchema.safeParse(value)
  if (!parsed.success) return value

  const event = parsed.data
  const type = LEGACY_EVENT_TYPES[event.type] ?? event.type
  const runtime = event.runtime ?? event.project
  const connector = event.connector ?? event.channel
  const reason = event.reason === "tenant_stopped" ? "runtime_stopped" : event.reason

  return {
    ...event,
    type,
    ...(runtime === undefined ? {} : { runtime }),
    ...(connector === undefined ? {} : { connector }),
    ...(reason === undefined ? {} : { reason }),
  }
}, leucoEventSchema)
