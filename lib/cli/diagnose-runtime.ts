import pkg from "../../package.json" with { type: "json" }
import { readDiagnosticConfiguration } from "@/cli/read-diagnostic-configuration"
import { inspectLaunchEnvironment } from "@/cli/inspect-launch-environment"
import { inspectDaemonControl } from "@/cli/inspect-daemon-control"
import { inspectDiagnosticHistory } from "@/cli/inspect-diagnostic-history"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { readMaintenance } from "@/maintenance/read-maintenance"
import { z } from "zod"

const reportedPersistenceFailureSchema = z.object({
  running: z.literal(true),
  runtime: z.object({ logs: z.object({ failedWrites: z.number().int().positive() }) }),
})

export async function diagnoseRuntime(home: string, signal?: AbortSignal) {
  const store = new NodeLeucoStore(home)
  const configuration = readDiagnosticConfiguration(store, new NodeMaintenanceStore(home))
  const environment = inspectLaunchEnvironment({
    store,
    settings: configuration.settings,
    launch: configuration.launch,
  })
  const maintenance = readMaintenance(home)
  const control = await inspectDaemonControl(home, signal, maintenance)
  const history = inspectDiagnosticHistory(home, control.daemon)
  const errors = [
    ...configuration.errors,
    ...environment.errors,
    ...control.errors,
    ...history.errors,
  ]
  const failures = [
    ...configuration.failures,
    ...environment.failures,
    ...control.failures,
    ...history.failures,
  ]
  if (maintenance && "eventLogError" in maintenance && maintenance.eventLogError) {
    errors.push(`Maintenance event persistence failed: ${maintenance.eventLogError}`)
    if (maintenance.eventLogCauses)
      failures.push({ phase: "maintenance-event-log", causes: maintenance.eventLogCauses })
  }
  if (!control.processAlive && maintenance && ["failed", "uncertain"].includes(maintenance.status))
    errors.push(
      `Latest restart is ${maintenance.status}: ${maintenance.error ?? "Inspect maintenance progress and logs"}`,
    )
  if (maintenance?.status === "unreadable")
    errors.push("Maintenance journal is invalid; preserve it for inspection")
  return {
    ...environment,
    slackConfigured: configuration.settings.slack !== null,
    versions: {
      leuco: pkg.version,
      bun: Bun.version,
      flume: pkg.dependencies["@interactive-inc/flume"],
    },
    daemon: control.daemon,
    controlError: control.controlError,
    staleLease: control.staleLease,
    maintenance,
    launch: configuration.launch,
    settingsValid: configuration.valid,
    stateValid: configuration.stateValid,
    leaseValid: control.leaseValid,
    eventLogValid: history.eventLogValid,
    recentFailures: history.recentFailures,
    errors,
    failures,
    repairable: {
      staleLease: control.staleLease,
      invalidState: !configuration.stateValid && control.leaseValid && !control.processAlive,
    },
    healthy: errors.length === 0,
    hints: [
      ...(reportedPersistenceFailureSchema.safeParse(control.daemon).success
        ? [
            "This daemon reported event write failures; saved history may have gaps even after writes recover. healthy describes current checks. Inspect status runtime.logs and text logs before treating a missing event as proof that no operation occurred.",
          ]
        : []),
      "Use events --summary to find important activity, then events --request <requestId> for details.",
      "Use status to inspect active request, last activity, queue depth, log health and maintenance progress.",
      "Do not replay failed writes or agent prompts automatically.",
      "Credential setup is clipboard-only: copy one token and run leuco slack login bot or leuco slack login app.",
    ],
  }
}
