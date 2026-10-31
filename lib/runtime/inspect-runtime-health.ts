import { z } from "zod"

const statusSchema = z.object({
  ready: z.boolean(),
  runtime: z.object({
    codexRunning: z.boolean(),
    codex: z
      .object({
        starting: z.boolean().optional(),
        stopping: z.boolean().optional(),
        cleaningUp: z.boolean().optional(),
        diagnostics: z.object({ healthy: z.boolean() }).optional(),
      })
      .nullable()
      .optional(),
    logs: z.object({ lastWriteFailed: z.boolean() }).optional(),
    textLog: z.object({ healthy: z.boolean() }).optional(),
    logConsumer: z.object({ healthy: z.boolean() }).optional(),
    connections: z
      .array(
        z.object({
          name: z.string(),
          type: z.string().optional(),
          health: z
            .object({
              state: z.string(),
              diagnostics: z.object({ healthy: z.boolean() }).optional(),
            })
            .optional(),
        }),
      )
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
  const codexTransition =
    [
      { active: runtime.codex?.cleaningUp, name: "cleaning up" },
      { active: runtime.codex?.stopping, name: "stopping" },
      { active: runtime.codex?.starting, name: "starting" },
    ].find((transition) => transition.active === true)?.name ?? null
  if (!parsed.data.ready)
    issues.push("Daemon is starting or stopping; observe status before restarting")
  if (codexTransition !== null)
    issues.push(`Codex child is ${codexTransition}; observe status and events before restarting`)
  else if (!runtime.codexRunning)
    issues.push(
      "Codex child is unavailable; repair/restart can recover the connection without replaying work",
    )
  const failed = (runtime.connections ?? []).filter(
    (connection) => connection.health && !["connected", "ready"].includes(connection.health.state),
  )
  for (const connection of failed)
    issues.push(
      connection.type === "schedule" && connection.health?.state === "error"
        ? `Schedule connector ${connection.name} is error; inspect its settings, storage and turn errors before the next tick`
        : `Connector ${connection.name} is ${connection.health?.state}; inspect events for its connection and recovery history`,
    )
  for (const connection of runtime.connections ?? [])
    if (connection.health?.diagnostics?.healthy === false)
      issues.push(
        `Connector ${connection.name} log delivery is degraded; inspect its diagnostic causes and log destinations`,
      )
  if (runtime.codex?.diagnostics?.healthy === false)
    issues.push(
      "Codex diagnostic output is degraded; inspect runtime.codex.diagnostics.lastFailure and stderr",
    )
  if (runtime.logs?.lastWriteFailed)
    issues.push("Event persistence is degraded; inspect disk space and permissions")
  if (runtime.logConsumer?.healthy === false)
    issues.push(
      "Runtime log consumer is degraded; inspect runtime.logConsumer.lastFailure and the host log destination",
    )
  if (runtime.textLog?.healthy === false)
    issues.push("Text log persistence is degraded; inspect disk space and permissions")
  return {
    healthy: issues.length === 0,
    restartRecommended:
      parsed.data.ready &&
      ((!runtime.codexRunning && codexTransition === null) ||
        failed.some(
          (connection) =>
            connection.health?.state === "disconnected" ||
            (connection.health?.state === "error" && connection.type !== "schedule"),
        )),
    issues,
  }
}
