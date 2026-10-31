import type { LogLevel } from "@/log-level"
import { getCodexLogLevel } from "@/engine/codex/get-codex-log-level"

/** Pipe chunks are not lines; retain bounded partial text until framing and redaction are possible. */
export class CodexStderrLog {
  private readonly pending = { text: "", chars: 0 }

  constructor(private readonly emit: (line: string, level: LogLevel) => void) {
    Object.freeze(this)
  }

  write(chunk: string): void {
    const lines = chunk.split("\n")
    for (const index of lines.keys()) {
      const line = lines[index]!
      this.pending.chars += line.length
      // A clipped prefix can expose part of a secret that redaction can no longer match.
      this.pending.text = this.pending.chars > 12_000 ? "" : this.pending.text + line
      if (index < lines.length - 1) this.flush()
    }
  }

  flush(): void {
    const line = this.pending.text.replace(/\r$/, "")
    const truncated = this.pending.chars > 12_000
    const omitted = `[truncated stderr line; content omitted before redaction; original chars=${this.pending.chars}]`
    this.pending.text = ""
    this.pending.chars = 0
    if (truncated) this.emit(omitted, "warn")
    else if (line.trim()) this.emit(line, getCodexLogLevel(line))
  }
}
