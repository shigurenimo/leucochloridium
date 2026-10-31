import { DiagnosticOutput } from "@/diagnostic-output"

export class MemoryDiagnosticOutput extends DiagnosticOutput {
  readonly attempts: string[] = []
  failure: Error | null = null

  async write(line: string): Promise<void> {
    this.attempts.push(line)
    if (this.failure !== null) throw this.failure
  }
}
