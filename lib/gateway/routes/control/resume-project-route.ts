import { factory } from "@/gateway/gateway-factory"

export const resumeProjectHandler = factory.createHandlers(async (context) => {
  const projectId = context.req.param("projectId")!
  await context.var.deps.control.resumeProject(projectId)

  return context.json({ ok: true, projectId })
})
