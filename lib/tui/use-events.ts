import { useSyncExternalStore } from "react"
import type { LeucoEvent } from "@/events/leuco-event-types"
import type { LeucoEventLogStore } from "@/tui/event-log-store"

type Props = {
  store: LeucoEventLogStore
}

/**
 * Subscribe to a `LeucoEventLogStore` from inside React. The store owns the
 * tail subscription and the rolling buffer; this hook is a thin React adapter
 * that re-renders whenever the buffer changes. `useEffect` is intentionally
 * avoided so the React tree never owns IO lifecycle.
 */
export const useEvents = (props: Props): ReadonlyArray<LeucoEvent> => {
  return useSyncExternalStore(props.store.subscribe, props.store.getSnapshot)
}
