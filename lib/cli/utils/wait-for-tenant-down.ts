import { z } from "zod"
import { DEFAULT_LEUCO_PORT, cliEnvSchema } from "@/env/cli-env-schema"

const POLL_INTERVAL_MS = 150
const DEFAULT_TIMEOUT_MS = 15_000

const statusProjectsSchema = z
  .object({
    projects: z.array(z.object({ id: z.string(), tenantRunning: z.boolean() }).passthrough()),
  })
  .passthrough()

/**
 * Wait until the daemon has actually torn the project's tenant down by
 * polling the gateway's `/status`. The disable→enable restart flow used to
 * sleep a fixed 400ms and hope the SIGHUP-driven reconcile had read the
 * disabled state in time — when reconcile was busy (a tenant stop can take
 * the full 5s codex SIGTERM grace), the re-enable landed first and "restarted"
 * was a silent no-op, leaving e.g. a rotated MCP token unpicked.
 *
 * Returns true only when the tenant is confirmed down. A temporarily
 * unreachable gateway remains unknown and is retried until timeout.
 */
export const waitForTenantDown = async (
  projectId: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<boolean> => {
  const port = resolveGatewayPort()
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const running = await tenantRunning(port, projectId)
    if (running === false) return true
    await sleep(POLL_INTERVAL_MS)
  }
  return false
}

const resolveGatewayPort = (): number => {
  const parsed = cliEnvSchema.safeParse(process.env)
  return parsed.success ? parsed.data.LEUCO_PORT : DEFAULT_LEUCO_PORT
}

/** true = tenant up, false = tenant down, null = gateway unreachable/unknown. */
const tenantRunning = async (port: number, projectId: string): Promise<boolean | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: AbortSignal.timeout(1_000),
    })
    if (!response.ok) return null

    const parsed = statusProjectsSchema.safeParse(await response.json())
    if (!parsed.success) return null

    const project = parsed.data.projects.find((p) => p.id === projectId)
    if (project === undefined) return false
    return project.tenantRunning
  } catch {
    return null
  }
}

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
