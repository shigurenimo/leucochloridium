import { createFactory } from "hono/factory"
import type { GatewayRouteDeps } from "@/gateway/gateway-route-deps"

export type Env = {
  Variables: {
    deps: GatewayRouteDeps
  }
}

export const factory = createFactory<Env>()
