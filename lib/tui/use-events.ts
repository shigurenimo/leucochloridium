import { useEffect, useState } from "react"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { tailEventsJsonl } from "@/tui/utils/tail-events-jsonl"

type Props = {
  path: string
  capacity?: number
}

/**
 * React hook that tails the daemon's `events.jsonl` and exposes the most
 * recent N events as state. Capacity-bounded so memory stays flat for long
 * sessions; oldest events are dropped first.
 */
export const useEvents = (props: Props): LeucoEvent[] => {
  const [events, setEvents] = useState<LeucoEvent[]>([])

  useEffect(() => {
    const cap = props.capacity ?? 500

    const stop = tailEventsJsonl({
      path: props.path,
      onEvent: (event) => {
        setEvents((prev) => {
          const next = [...prev, event]
          if (next.length > cap) next.splice(0, next.length - cap)
          return next
        })
      },
    })

    return () => {
      stop()
    }
  }, [props.path, props.capacity])

  return events
}
