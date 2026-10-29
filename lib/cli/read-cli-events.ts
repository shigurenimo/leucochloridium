import { existsSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { readLeucoEvents } from "@/events/read-leuco-events"

type Props = {
  home: string
  limit: number
  requestId: string
  signal?: AbortSignal
  filters: { requestId?: string; type?: string; since?: number }
}

/** Control is an optional, bounded probe; saved history remains readable when the bot is wedged. */
export async function readCliEvents(props: Props) {
  const probe: { failure: unknown } = { failure: null }
  try {
    const lease = readDaemonLease(props.home)
    if (lease !== null && isProcessAlive(lease.pid)) {
      const status = z
        .object({ runtime: z.object({ logs: z.object({ mode: z.string() }) }) })
        .parse(
          await requestDaemon({
            home: props.home,
            path: "/status",
            requestId: props.requestId,
            signal: props.signal,
            timeoutMs: 200,
          }),
        )
      if (status.runtime.logs.mode === "memory-fallback") {
        const query = new URLSearchParams({ limit: String(props.limit) })
        if (props.filters.requestId) query.set("requestId", props.filters.requestId)
        if (props.filters.type) query.set("type", props.filters.type)
        if (props.filters.since !== undefined) query.set("sinceTs", String(props.filters.since))
        return await requestDaemon({
          home: props.home,
          path: `/events?${query}`,
          requestId: props.requestId,
          signal: props.signal,
          timeoutMs: 1000,
        })
      }
    }
  } catch (error) {
    probe.failure = error
  }
  try {
    const path = join(props.home, "events.db")
    return existsSync(path) ? readLeucoEvents(path, props.limit, props.filters) : []
  } catch (error) {
    if (probe.failure !== null)
      throw new AggregateError(
        [error, probe.failure],
        "Saved event history and live daemon history could not be read; inspect both causes",
        { cause: error },
      )
    throw error
  }
}
