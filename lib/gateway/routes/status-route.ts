import { factory } from "@/gateway/gateway-factory"

/** GET /status — snapshot including the active thread map. */
export const statusHandler = factory.createHandlers((c) => {
  const deps = c.var.deps

  return c.json({
    ok: true,
    pid: deps.selfPid,
    cwd: deps.control.getCwd(),
    connectors: deps.control.listConnectors(),
    codexRunning: deps.control.isCodexRunning(),
    threads: deps.control.listThreads(),
    projects: deps.control.listProjects(),
  })
})
