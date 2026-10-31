import type { DiagnosticOutput } from "@/diagnostic-output"
import { NodeDiagnosticOutput } from "@/node-diagnostic-output"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorDetails } from "@/error-details"
import { errorFromDetails } from "@/error-from-details"
import type { LogDeliveryHealth } from "@/log-delivery-health-schema"
import { formatCodexConsumerError } from "@/engine/codex/format-codex-consumer-error"

type Failure = { kind: "log" | "notification"; error: unknown }

export class CodexConsumerDiagnostics {
  private readonly output: DiagnosticOutput
  private readonly redactLogText: ((text: string) => string) | undefined
  private readonly pending = new Set<Promise<void>>()
  private readonly state: LogDeliveryHealth & { failureVersion: number } = {
    healthy: true,
    lastFailure: null,
    failureVersion: 0,
  }

  constructor(props: { output?: DiagnosticOutput; redactLogText?: (text: string) => string }) {
    this.output = props.output ?? new NodeDiagnosticOutput()
    this.redactLogText = props.redactLogText
    Object.freeze(this)
  }

  report(failure: Failure): void {
    const captured = {
      kind: failure.kind,
      error: errorFromDetails(errorDetails(failure.error, [], this.redactLogText)),
    }
    if (this.pending.size >= 64) {
      this.recordFailure(
        captured.error,
        Object.assign(
          new Error("Codex diagnostics have 64 unconfirmed writes; delivery was not attempted"),
          { code: "EBUSY" },
        ),
      )
      return
    }
    const observed = this.deliver(captured).finally(() => {
      this.pending.delete(observed)
    })
    this.pending.add(observed)
  }

  private async deliver(failure: Failure): Promise<void> {
    const version = this.state.failureVersion
    try {
      const line = formatCodexConsumerError({ ...failure, redactLogText: this.redactLogText })
      await awaitBoundedCleanup(this.output.write(`${line}\n`), "Codex diagnostic output", 1000)
      if (this.state.failureVersion === version) this.state.healthy = true
    } catch (reporting) {
      this.recordFailure(failure.error, reporting)
    }
  }

  private recordFailure(primary: unknown, reporting: unknown): void {
    this.state.healthy = false
    this.state.failureVersion += 1
    this.state.lastFailure = {
      ts: Date.now(),
      message: "Codex diagnostic output failed",
      causes: errorDetails(
        new AggregateError([primary, reporting], "Codex consumer and diagnostic output failed", {
          cause: primary,
        }),
        [],
        this.redactLogText,
      ),
    }
  }

  getHealth() {
    return {
      healthy: this.state.healthy,
      pending: this.pending.size,
      maxPending: 64,
      lastFailure:
        this.state.lastFailure === null
          ? null
          : {
              ...this.state.lastFailure,
              causes: this.state.lastFailure.causes.map((cause) => ({ ...cause })),
            },
    }
  }

  async drain(): Promise<void> {
    await Promise.allSettled(this.pending)
  }
}
