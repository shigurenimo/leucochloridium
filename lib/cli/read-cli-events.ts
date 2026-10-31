import { lstatSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { readLeucoEvents } from "@/events/read-leuco-events"
import { parseVolatileEvents } from "@/cli/parse-volatile-events"

const logHealthSchema = z.object({
  mode: z.enum(["sqlite", "memory-fallback"]),
  failedWrites: z.number().int().nonnegative(),
  lastWriteFailed: z.boolean(),
  lastPersistError: z.record(z.string(), z.unknown()).nullable(),
  lastReportError: z.record(z.string(), z.unknown()).nullable().optional(),
  lastCloseError: z.record(z.string(), z.unknown()).nullable().optional(),
})

type Props = {
  home: string
  limit: number
  requestId: string
  signal?: AbortSignal
  filters: { requestId?: string; type?: string; since?: number; summary?: boolean }
}

/** Preserve readable saved history without claiming that unreachable volatile history is complete. */
export async function readCliEvents(props: Props) {
  const probe: {
    failure: unknown
    phase: string
    expectsSqlite: boolean
    persistence: z.infer<typeof logHealthSchema> | null
  } = {
    failure: null,
    phase: "control-probe",
    expectsSqlite: false,
    persistence: null,
  }
  try {
    const lease = readDaemonLease(props.home)
    if (lease !== null && isProcessAlive(lease.pid)) {
      const status = z
        .object({
          runtime: z.object({ logs: logHealthSchema }),
        })
        .parse(
          await requestDaemon({
            home: props.home,
            path: "/status",
            requestId: props.requestId,
            signal: props.signal,
            timeoutMs: 200,
            expectedLease: lease,
          }),
        )
      probe.expectsSqlite = status.runtime.logs.mode === "sqlite"
      if (status.runtime.logs.failedWrites > 0) probe.persistence = status.runtime.logs
      if (probe.expectsSqlite && status.runtime.logs.failedWrites > 0) {
        probe.phase = "history-persistence"
        throw new CliError(
          "STATE_UNCERTAIN",
          "This daemon has reported event write failures; saved history may have gaps even after writes recover. Inspect status and text logs before assuming an operation did not happen.",
        )
      }
      if (status.runtime.logs.mode === "memory-fallback") {
        probe.phase = "volatile-history"
        const query = new URLSearchParams({ limit: String(props.limit) })
        if (props.filters.requestId) query.set("requestId", props.filters.requestId)
        if (props.filters.type) query.set("type", props.filters.type)
        if (props.filters.since !== undefined) query.set("sinceTs", String(props.filters.since))
        if (props.filters.summary) query.set("summary", "true")
        const events = await requestDaemon({
          home: props.home,
          path: `/events?${query}`,
          requestId: props.requestId,
          signal: props.signal,
          timeoutMs: 1000,
          expectedLease: lease,
        })
        return parseVolatileEvents(events, {
          limit: props.limit,
          requestId: props.filters.requestId,
          type: props.filters.type,
          sinceTs: props.filters.since,
          summary: props.filters.summary,
        })
      }
    }
  } catch (error) {
    probe.failure = error
  }
  const saved: { entries: ReturnType<typeof readLeucoEvents> } = { entries: [] }
  try {
    const path = join(props.home, "events.db")
    const present = lstatSync(path, { throwIfNoEntry: false }) !== undefined
    if (!present && probe.expectsSqlite)
      throw new CliError(
        "STATE_UNCERTAIN",
        "Daemon reports SQLite history, but its event database is missing. Inspect status and logs; do not assume no work occurred.",
      )
    saved.entries = present ? readLeucoEvents(path, props.limit, props.filters) : []
  } catch (error) {
    if (probe.failure !== null) {
      const combined = new AggregateError([error, probe.failure], "History reads failed", {
        cause: error,
      })
      const failure = new CliError(
        "STATE_UNCERTAIN",
        "Saved event history could not be read and live history is unverified. Inspect both causes and known persistence diagnostics; do not assume an operation did not happen.",
        {
          phase: "saved-history",
          livePhase: probe.phase,
          source: "unavailable",
          liveHistoryVerified: false,
          savedHistoryVerified: false,
          historyComplete: false,
          ...(probe.persistence === null ? {} : { persistence: probe.persistence }),
          causes: errorDetails(combined),
        },
      )
      failure.cause = combined
      throw failure
    }
    throw error
  }
  if (probe.failure !== null)
    throw new CliError(
      "STATE_UNCERTAIN",
      probe.persistence === null
        ? "Saved event history is readable, but live history could not be verified. Inspect error.details.savedEvents; volatile events may be missing. Do not assume an operation did not happen."
        : "Saved event history is readable, but this daemon has reported event write failures. Inspect error.details.savedEvents and persistence, plus text logs; history may have gaps even after recovery. Do not assume an operation did not happen.",
      {
        phase: probe.phase,
        source: "saved",
        liveHistoryVerified: false,
        historyComplete: false,
        ...(probe.persistence === null ? {} : { persistence: probe.persistence }),
        savedEvents: saved.entries,
        causes: errorDetails(probe.failure),
      },
    )
  return saved.entries
}
