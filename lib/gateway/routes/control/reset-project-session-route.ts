import { factory } from "@/gateway/gateway-factory"

export const resetProjectSessionHandler = factory.createHandlers(async (context) => {
  const projectId = context.req.param("projectId")!
  await context.var.deps.control.resetProjectSession(projectId)

  return context.json({ ok: true, projectId })
})
