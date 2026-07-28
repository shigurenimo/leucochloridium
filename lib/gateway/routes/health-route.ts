import { factory } from "@/gateway/gateway-factory"

/** GET /health — liveness plus connector and Codex status. */
export const healthHandler = factory.createHandlers((c) => {
  const deps = c.var.deps

  return c.json({
    ok: true,
    pid: deps.selfPid,
    connectors: deps.control.listConnectors(),
    codexRunning: deps.control.isCodexRunning(),
  })
})
