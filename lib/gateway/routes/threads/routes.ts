import { factory } from "@/gateway/gateway-factory"
import { threadsClearHandler } from "@/gateway/routes/threads/clear-route"
import { threadsListHandler } from "@/gateway/routes/threads/list-route"

export const threadsRoutes = factory
  .createApp()
  .get("/threads", ...threadsListHandler)
  .post("/threads/clear", ...threadsClearHandler)
