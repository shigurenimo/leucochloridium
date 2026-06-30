import type { Context } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { errorMessage } from "@/error-message"

const cliBodySchema = z.object({
  args: z.array(z.string()).default([]),
  flags: z.record(z.string(), z.union([z.string(), z.boolean()])).default({}),
})

export type CliBody = z.infer<typeof cliBodySchema>

export const readCliBody = async (c: Context): Promise<CliBody> => {
  const text = await c.req.text()
  // Treat a literally empty body as `{}` (matches the previous fallback when
  // every leuco CLI invocation was JSON-encoded); only a body that contains
  // bytes but isn't valid JSON should be reported, so a future client bug
  // doesn't silently render as "no args".
  if (text.length === 0) return { args: [], flags: {} }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new HTTPException(400, { message: `invalid CLI body: ${errorMessage(error)}` })
  }
  const parsed = cliBodySchema.safeParse(raw)
  if (!parsed.success) {
    throw new HTTPException(400, { message: `invalid CLI body: ${parsed.error.message}` })
  }
  return parsed.data
}

export const flagBool = (value: string | boolean | undefined): boolean => {
  return value === true || value === "true"
}

export const flagString = (value: string | boolean | undefined): string | null => {
  if (typeof value === "string") return value
  return null
}
