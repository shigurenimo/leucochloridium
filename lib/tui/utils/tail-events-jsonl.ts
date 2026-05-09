import { existsSync, openSync, readSync, statSync, watch, closeSync } from "node:fs"
import { leucoEventSchema } from "@/events/leuco-event-schema"
import type { LeucoEvent } from "@/events/leuco-event-types"

type Listener = (event: LeucoEvent) => void

type Stop = () => void

/**
 * Tail an `events.jsonl` file in real time. On start, replays the last
 * `replay` lines so the TUI shows recent context; afterwards, watches for
 * file growth and emits each new line through `onEvent`. Truncations and
 * file-replacement (e.g. log rotation) are detected by comparing inode +
 * size and the watcher restarts from offset 0.
 */
export const tailEventsJsonl = (props: {
  path: string
  replay?: number
  onEvent: Listener
}): Stop => {
  const replay = props.replay ?? 200
  let offset = 0
  let buffer = ""

  const drain = (): void => {
    if (!existsSync(props.path)) return
    const stat = statSync(props.path)
    if (stat.size < offset) {
      // truncated / rotated → restart from 0
      offset = 0
      buffer = ""
    }
    if (stat.size === offset) return

    const fd = openSync(props.path, "r")
    try {
      const length = stat.size - offset
      const chunk = Buffer.alloc(length)
      readSync(fd, chunk, 0, length, offset)
      offset = stat.size
      buffer += chunk.toString("utf8")
    } finally {
      closeSync(fd)
    }

    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let raw: unknown
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue
      }
      const parsed = leucoEventSchema.safeParse(raw)
      if (parsed.success) props.onEvent(parsed.data)
    }
  }

  // Initial replay: position at max(0, size - rough_replay_chunk).
  if (existsSync(props.path)) {
    const stat = statSync(props.path)
    const approxLineSize = 240
    offset = Math.max(0, stat.size - replay * approxLineSize)
    buffer = ""
    drain()
  }

  const watcher = watch(props.path, { persistent: true }, () => {
    drain()
  })

  return () => {
    watcher.close()
  }
}
