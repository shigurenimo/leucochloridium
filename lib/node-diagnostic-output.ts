import { DiagnosticOutput } from "@/diagnostic-output"
import type { FileSink } from "bun"

export class NodeDiagnosticOutput extends DiagnosticOutput {
  private readonly state: { writer: FileSink | null; writing: boolean } = {
    writer: null,
    writing: false,
  }

  constructor(private readonly destination: "stdout" | "stderr" = "stderr") {
    super()
    Object.freeze(this)
  }

  async write(line: string): Promise<void> {
    if (this.state.writing)
      throw Object.assign(new Error("Diagnostic output is busy with an unconfirmed write"), {
        code: "EBUSY",
      })
    const writer =
      this.state.writer ??
      (this.destination === "stdout" ? Bun.stdout : Bun.stderr).writer({ highWaterMark: 1 })
    this.state.writer = writer
    this.state.writing = true
    const capture = (operation: () => number | Promise<number>): Promise<number> => {
      try {
        return Promise.resolve(operation())
      } catch (error) {
        return Promise.reject(error)
      }
    }
    try {
      const pending = Promise.allSettled([
        capture(() => writer.write(line)),
        capture(() => writer.flush()),
      ])
      // Flush may reactivate the pipe; release its liveness reference after both steps start.
      writer.unref()
      const outcomes = await pending
      const failures: unknown[] = []
      for (const outcome of outcomes)
        if (outcome.status === "rejected") failures.push(outcome.reason)
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1)
        throw new AggregateError(failures, "Diagnostic output write and flush failed", {
          cause: failures[0],
        })
      if (outcomes[0]?.status !== "fulfilled" || outcomes[0].value !== Buffer.byteLength(line))
        throw Object.assign(new Error("Diagnostic output write was incomplete"), { code: "EIO" })
    } finally {
      this.state.writing = false
    }
  }
}
