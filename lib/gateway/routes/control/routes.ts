import { factory } from "@/gateway/gateway-factory"
import { pauseProjectHandler } from "@/gateway/routes/control/pause-project-route"
import { reloadHandler } from "@/gateway/routes/control/reload-route"
import { resetProjectSessionHandler } from "@/gateway/routes/control/reset-project-session-route"
import { restartConnectorHandler } from "@/gateway/routes/control/restart-connector-route"
import { restartProjectHandler } from "@/gateway/routes/control/restart-project-route"
import { resumeProjectHandler } from "@/gateway/routes/control/resume-project-route"

export const controlRoutes = factory
  .createApp()
  .post("/control/reload", ...reloadHandler)
  .post("/projects/:projectId/restart", ...restartProjectHandler)
  .post("/projects/:projectId/pause", ...pauseProjectHandler)
  .post("/projects/:projectId/resume", ...resumeProjectHandler)
  .post("/projects/:projectId/session/reset", ...resetProjectSessionHandler)
  .post("/projects/:projectId/connectors/:connectorName/restart", ...restartConnectorHandler)
