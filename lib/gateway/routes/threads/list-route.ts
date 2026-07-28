import { factory } from "@/gateway/gateway-factory"

/** GET /threads — current thread→codexThreadId map. */
export const threadsListHandler = factory.createHandlers((c) => {
  return c.json({ threads: c.var.deps.control.listThreads() })
})
