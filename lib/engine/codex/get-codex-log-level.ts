import type { LogLevel } from "@/log-level"
import { z } from "zod"

const schema = z.object({ level: z.string() })

export function getCodexLogLevel(line: string): LogLevel {
  try {
    const parsed = schema.safeParse(JSON.parse(line))
    if (!parsed.success) return "info"
    const level = parsed.data.level.toLowerCase()
    if (level === "error" || level === "fatal") return "error"
    if (level === "warn" || level === "warning") return "warn"
    return "info"
  } catch {
    return "info"
  }
}
