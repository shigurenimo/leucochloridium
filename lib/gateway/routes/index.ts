import { factory } from "@/gateway/gateway-factory"
import { healthHandler } from "@/gateway/routes/health-route"
import { mcpHandler } from "@/gateway/routes/mcp-route"
import { statusHandler } from "@/gateway/routes/status-route"
import { threadsRoutes } from "@/gateway/routes/threads/routes"

/**
 * Top-level Hono app for the leuco gateway. Deps come from the `deps`
 * variable set by `LeucoGatewayServer`'s middleware.
 */
export const gatewayRoutes = factory
  .createApp()
  .get("/health", ...healthHandler)
  .get("/status", ...statusHandler)
  .all("/mcp/:project", ...mcpHandler)
  .route("/", threadsRoutes)
