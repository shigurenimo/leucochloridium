import { z } from "zod"
import { errorDetailsSchema } from "@/error-details-schema"
import { cliErrorCodeSchema } from "@/cli/cli-error"

export const daemonFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  code: cliErrorCodeSchema,
  details: z.unknown(),
  causes: errorDetailsSchema.max(8),
})

export const daemonFailureResponseSchema = z.object({
  error: z.string(),
  requestId: z.string().min(1),
  failure: daemonFailureSchema,
})

export type DaemonFailure = z.infer<typeof daemonFailureSchema>
