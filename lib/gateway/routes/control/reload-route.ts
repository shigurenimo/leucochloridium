import { factory } from "@/gateway/gateway-factory"

export const reloadHandler = factory.createHandlers(async (context) => {
  await context.var.deps.control.reload()

  return context.json({ ok: true })
})
