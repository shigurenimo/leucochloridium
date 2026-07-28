import { factory } from "@/gateway/gateway-factory"

export const pauseProjectHandler = factory.createHandlers(async (context) => {
  const projectId = context.req.param("projectId")!
  await context.var.deps.control.pauseProject(projectId)

  return context.json({ ok: true, projectId })
})
