import { z } from "zod"

export const errorDetailsSchema = z.array(
  z.object({
    name: z.string(),
    message: z.string(),
    stack: z.string().nullable(),
    code: z.string().nullable(),
  }),
)
