import type { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { errorMessage } from "@/error-message"
import { type Env, factory } from "@/gateway/gateway-factory"
import type { GatewayRouteDeps } from "@/gateway/gateway-route-deps"
import { gatewayRoutes } from "@/gateway/routes"

/**
 * Builds the Hono app served by `LeucoGatewayServer`. Pulled out so tests can
 * exercise the routes directly via `app.request(...)` without spinning up
 * `Bun.serve`.
 */
export const buildGatewayApp = (deps: GatewayRouteDeps): Hono<Env> => {
  const base = factory.createApp()

  base.use((c, next) => {
    c.set("deps", deps)
    return next()
  })

  // Mirror the CLI's onError so handlers can `throw new HTTPException(...)`
  // instead of `return c.text("...", 4xx)` (project rule).
  base.onError((error, c) => {
    if (error instanceof HTTPException) {
      return c.text(`error: ${error.message}`, error.status)
    }
    return c.text(`error: ${errorMessage(error)}`, 500)
  })

  return base.route("/", gatewayRoutes)
}
