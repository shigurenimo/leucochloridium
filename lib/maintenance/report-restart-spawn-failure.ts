import { appendDaemonLog } from "@/daemon/append-daemon-log"
import type { DiagnosticOutput } from "@/diagnostic-output"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"
import { formatLogLine } from "@/format-log-line"
import type { MaintenanceOperation } from "@/maintenance/maintenance-schema"
import { recordRestartSpawnFailure } from "@/maintenance/record-restart-spawn-failure"
import { NodeDiagnosticOutput } from "@/node-diagnostic-output"
import { toPublicDiagnosticMessage } from "@/to-public-diagnostic-message"

type Props = {
  home: string
  operation: MaintenanceOperation
  error: unknown
  output?: DiagnosticOutput
}

/**
 * Runs in the worker's asynchronous 'error' listener, where a throw would become the daemon's
 * uncaughtException and stop it. When the failure journal cannot be saved either, daemon.log keeps
 * both causes; stderr is the fallback because it needs no new descriptor (EMFILE).
 */
export function reportRestartSpawnFailure(props: Props): void {
  try {
    recordRestartSpawnFailure(props.home, props.operation, props.error)
    return
  } catch (failure) {
    const causes = errorDetails(failure)
      .slice(1)
      .map((cause) => `${cause.code ?? cause.name}: ${cause.message}`)
      .join(" | ")
    const line = `[error] requestId=${props.operation.id} ${toPublicDiagnosticMessage(errorMessage(failure))}; causes: ${causes}`
    try {
      appendDaemonLog(props.home, line)
    } catch {
      void Promise.resolve()
        .then(() =>
          (props.output ?? new NodeDiagnosticOutput()).write(
            `${formatLogLine(`leuco: ${line}`)}\n`,
          ),
        )
        .catch(() => {})
    }
  }
}
