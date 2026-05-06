import { factory } from "@/gateway/gateway-factory"

/** GET /health — liveness + plugin/codex connection snapshot. */
export const healthHandler = factory.createHandlers((c) => {
  const deps = c.var.deps

  return c.json({
    ok: true,
    pid: deps.selfPid,
    plugins: deps.engine.listPlugins(),
    codexRunning: deps.engine.isCodexRunning(),
  })
})
