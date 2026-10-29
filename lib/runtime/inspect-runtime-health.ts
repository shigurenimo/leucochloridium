import { z } from "zod"

const statusSchema = z.object({
  ready: z.boolean(),
  runtime: z.object({
    codexRunning: z.boolean(),
    logs: z.object({ lastWriteFailed: z.boolean() }).optional(),
    textLog: z.object({ healthy: z.boolean() }).optional(),
    connections: z
      .array(z.object({ name: z.string(), health: z.object({ state: z.string() }).optional() }))
      .optional(),
  }),
})

/** Readiness, transport health and persistence are distinct observations. */
export function inspectRuntimeHealth(status: unknown) {
  const parsed = statusSchema.safeParse(status)
  if (!parsed.success)
    return {
      healthy: false,
      restartRecommended: false,
      issues: [
        "Daemon status is invalid or incomplete; inspect versions and logs before taking action",
      ],
    }
  const runtime = parsed.data.runtime
  const issues: string[] = []
  if (!parsed.data.ready)
    issues.push("Daemon is starting or stopping; observe status before restarting")
  if (!runtime.codexRunning)
    issues.push(
      "Codex child is unavailable; repair/restart can recover the connection without replaying work",
    )
  const failed = (runtime.connections ?? []).filter(
    (connection) => connection.health && !["connected", "ready"].includes(connection.health.state),
  )
  for (const connection of failed)
    issues.push(
      `Connector ${connection.name} is ${connection.health?.state}; inspect events for its connection and recovery history`,
    )
  if (runtime.logs?.lastWriteFailed)
    issues.push("Event persistence is degraded; inspect disk space and permissions")
  if (runtime.textLog?.healthy === false)
    issues.push("Text log persistence is degraded; inspect disk space and permissions")
  return {
    healthy: issues.length === 0,
    restartRecommended:
      parsed.data.ready &&
      (!runtime.codexRunning ||
        failed.some((connection) =>
          ["disconnected", "error"].includes(connection.health?.state ?? ""),
        )),
    issues,
  }
}
