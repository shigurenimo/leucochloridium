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
    return c.json({ ok: false, reason: "threadKey required in body" }, 400)
  }

  const cleared = c.var.deps.engine.clearThread(parsed.data.threadKey)

  return c.json({ ok: cleared, threadKey: parsed.data.threadKey }, cleared ? 200 : 404)
})
