import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { factory } from "@/gateway/gateway-factory"

const bodySchema = z.object({
  threadKey: z.string().min(1),
})

/**
 * POST /threads/clear — drop the mapping so the next message in this thread
 * starts a fresh Codex thread.
 */
export const threadsClearHandler = factory.createHandlers(async (c) => {
  const raw = await c.req.json().catch(() => ({}))
  const parsed = bodySchema.safeParse(raw)

  if (!parsed.success) {
    throw new HTTPException(400, { message: "threadKey required in body" })
  }

  const cleared = c.var.deps.engine.clearThread(parsed.data.threadKey)
  if (!cleared) {
    throw new HTTPException(404, {
      message: `thread not found: ${parsed.data.threadKey}`,
    })
  }

  return c.json({ ok: true, threadKey: parsed.data.threadKey })
})
