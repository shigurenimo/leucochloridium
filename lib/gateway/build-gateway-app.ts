import type { Hono } from "hono"
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

  return base.route("/", gatewayRoutes)
}
