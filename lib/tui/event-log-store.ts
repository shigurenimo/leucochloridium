import type { LeucoEvent } from "@/events/leuco-event-types"
import { tailEventsJsonl } from "@/tui/utils/tail-events-jsonl"

type Listener = () => void

type Props = {
  capacity?: number
}

const DEFAULT_CAPACITY = 500

/**
 * External event-log store the TUI subscribes to via `useSyncExternalStore`.
 * The store is a pure observable: callers feed events through `push()` and the
 * subscription wiring lives outside React. `useEffect` is forbidden by
 * project rules and `useSyncExternalStore` only needs a snapshot + subscribe
 * callback — both pure data, no lifecycle.
 *
 * The buffer is capacity-bounded so memory stays flat across long sessions;
 * the oldest events are dropped first. Each push allocates a fresh array so
 * snapshot equality lines up with React's `useSyncExternalStore` expectations
 * (referential change on every visible update).
 */
export class LeucoEventLogStore {
  private readonly capacity: number
  private readonly listeners = new Set<Listener>()
  private currentSnapshot: ReadonlyArray<LeucoEvent> = []

  constructor(props: Props = {}) {
    this.capacity = props.capacity ?? DEFAULT_CAPACITY
  }

  getSnapshot = (): ReadonlyArray<LeucoEvent> => {
    return this.currentSnapshot
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  push(event: LeucoEvent): void {
    const next = [...this.currentSnapshot, event]
    if (next.length > this.capacity) next.splice(0, next.length - this.capacity)
    this.currentSnapshot = next
    for (const listener of this.listeners) listener()
  }
}

/**
 * Pipe `events.jsonl` from `path` into `store`. Returns a stop handle that
 * closes the underlying file watcher. The store remains usable after stop —
 * only the IO side is torn down.
 */
export const tailEventsIntoStore = (props: {
  store: LeucoEventLogStore
  path: string
}): (() => void) => {
  return tailEventsJsonl({
    path: props.path,
    onEvent: (event) => props.store.push(event),
  })
}
