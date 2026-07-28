import { factory } from "@/gateway/gateway-factory"

export const restartProjectHandler = factory.createHandlers(async (context) => {
  const projectId = context.req.param("projectId")!
  await context.var.deps.control.restartProject(projectId)

  return context.json({ ok: true, projectId })
})
