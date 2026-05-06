import { factory } from "@/gateway/gateway-factory"

/** GET /status — snapshot including the active thread map. */
export const statusHandler = factory.createHandlers((c) => {
  const deps = c.var.deps

  return c.json({
    ok: true,
    pid: deps.selfPid,
    cwd: deps.engine.getCwd(),
    plugins: deps.engine.listPlugins(),
    codexRunning: deps.engine.isCodexRunning(),
    threads: deps.engine.listThreads(),
  })
})
