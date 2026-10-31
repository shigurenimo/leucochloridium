import { lstatSync } from "node:fs"
import { join } from "node:path"
import { errorDetails } from "@/error-details"
import { readLeucoEvents } from "@/events/read-leuco-events"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { z } from "zod"

const liveSqliteSchema = z.object({
  running: z.literal(true),
  runtime: z.object({ logs: z.object({ mode: z.literal("sqlite") }) }),
})

export function inspectDiagnosticHistory(home: string, liveStatus?: unknown) {
  const errors: string[] = []
  const failures: Array<{ phase: string; causes: ReturnType<typeof errorDetails> }> = []
  const history: {
    entries: Array<{ seq: number; ts: number; event: LeucoEvent }>
    valid: boolean
    present: boolean | null
  } = { entries: [], valid: true, present: null }
  try {
    const path = join(home, "events.db")
    const present = lstatSync(path, { throwIfNoEntry: false }) !== undefined
    history.present = present
    if (!present && liveSqliteSchema.safeParse(liveStatus).success)
      throw new Error("Daemon reports SQLite history, but its event database is missing")
    if (present) history.entries = readLeucoEvents(path, 10, { failuresOnly: true })
  } catch (error) {
    failures.push({ phase: "event-log", causes: errorDetails(error) })
    history.valid = false
    errors.push(
      "Event database is missing or unreadable; inspect status and text logs. It was not created or replaced.",
    )
  }
  return {
    eventLogValid: history.valid,
    eventLogPresent: history.present,
    recentFailures: history.entries,
    errors,
    failures,
  }
}
