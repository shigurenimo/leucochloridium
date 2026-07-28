import type { FlumeCron } from "@interactive-inc/flume/time"
import { parseCron } from "@interactive-inc/flume/time"

export function parseScheduleCron(expression: string): FlumeCron | null {
  const parsed = parseCron(expression)

  return parsed instanceof Error ? null : parsed
}
