import { factory } from "@/gateway/gateway-factory"

export const restartConnectorHandler = factory.createHandlers(async (context) => {
  const projectId = context.req.param("projectId")!
  const connectorName = context.req.param("connectorName")!
  await context.var.deps.control.restartConnector(projectId, connectorName)

  return context.json({ ok: true, projectId, connectorName })
})
