import { formatLogLine } from "@/format-log-line"
import { appendDaemonLog } from "@/daemon/append-daemon-log"
import { errorDetails } from "@/error-details"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import type { DiagnosticOutput } from "@/diagnostic-output"
import { NodeDiagnosticOutput } from "@/node-diagnostic-output"
import { errorMessage } from "@/error-message"
import { redactPublicText } from "@/secrets/redact-public-text"
import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

/** Text logging is best effort, but its failure remains inspectable. */
export class DaemonTextLog {
  private readonly state: {
    healthy: boolean
    lastErrorAt: number | null
    lastFailure: { message: string; causes: ReturnType<typeof errorDetails> } | null
    lastReportError: { ts: number; message: string; causes: ReturnType<typeof errorDetails> } | null
    lastReportedTick: number | null
  } = {
    healthy: true,
    lastErrorAt: null,
    lastFailure: null,
    lastReportError: null,
    lastReportedTick: null,
  }
  private readonly diagnosticOutput: DiagnosticOutput

  constructor(private readonly props: { home: string; diagnosticOutput?: DiagnosticOutput }) {
    this.diagnosticOutput = props.diagnosticOutput ?? new NodeDiagnosticOutput()
    Object.freeze(this)
  }

  write(line: string): Error | null {
    try {
      appendDaemonLog(this.props.home, line)
      this.state.healthy = true
      return null
    } catch (error) {
      const primary =
        error instanceof Error ? error : new Error("Text log write failed", { cause: error })
      const message = truncateDiagnosticText(
        redactPublicText(errorMessage(primary)),
        MAX_DIAGNOSTIC_MESSAGE_CHARACTERS,
      )
      const snapshot = { message, causes: errorDetails(primary) }
      this.state.healthy = false
      this.state.lastErrorAt = Date.now()
      this.state.lastFailure = snapshot
      if (
        this.state.lastReportedTick !== null &&
        performance.now() - this.state.lastReportedTick <= 60000
      )
        return primary
      this.state.lastReportedTick = performance.now()
      const reportFailure = (reporting: unknown): Error => {
        const combined = new AggregateError(
          [primary, reporting],
          "Text log persistence and stderr reporting failed",
          { cause: primary },
        )
        const causes = errorDetails(combined)
        this.state.lastReportError = { ts: Date.now(), message: combined.message, causes }
        if (this.state.lastFailure === snapshot) snapshot.causes = causes
        return combined
      }
      try {
        void awaitBoundedCleanup(
          this.diagnosticOutput.write(
            `${formatLogLine(`leuco: text log persistence failed: ${message}`)}\n`,
          ),
          "Text log error diagnostic output",
        ).catch(reportFailure)
      } catch (reporting) {
        return reportFailure(reporting)
      }
      return primary
    }
  }

  getHealth() {
    return {
      healthy: this.state.healthy,
      lastErrorAt: this.state.lastErrorAt,
      lastReportError:
        this.state.lastReportError === null
          ? null
          : {
              ...this.state.lastReportError,
              causes: this.state.lastReportError.causes.map((cause) => ({ ...cause })),
            },
      lastFailure:
        this.state.lastFailure === null
          ? null
          : {
              message: this.state.lastFailure.message,
              causes: this.state.lastFailure.causes.map((cause) => ({ ...cause })),
            },
    }
  }
}
