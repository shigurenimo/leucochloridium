import { z } from "zod"
import { errorDetailsSchema } from "@/error-details-schema"

export const logDeliveryHealthSchema = z.object({
  healthy: z.boolean(),
  lastFailure: z
    .object({
      ts: z.number(),
      message: z.string(),
      causes: errorDetailsSchema,
    })
    .nullable(),
})
export type LogDeliveryHealth = z.infer<typeof logDeliveryHealthSchema>
