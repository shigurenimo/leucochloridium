import type { Context } from "hono"
import { z } from "zod"

const cliBodySchema = z.object({
  args: z.array(z.string()).default([]),
  flags: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
})

export type CliBody = z.infer<typeof cliBodySchema>

export const readCliBody = async (c: Context): Promise<CliBody> => {
  const raw = await c.req.json().catch(() => ({}))
  return cliBodySchema.parse(raw)
}

export const flagBool = (value: string | boolean | undefined): boolean => {
  return value === true || value === "true"
}

export const flagString = (value: string | boolean | undefined): string | null => {
  if (typeof value === "string") return value
  return null
}
