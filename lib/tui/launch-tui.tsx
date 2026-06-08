/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { LeucoPaths } from "@/paths/leuco-paths"
import { App } from "@/tui/app"
import { LeucoEventLogStore, tailEventsIntoStore } from "@/tui/event-log-store"

/**
 * TUI を起動する。daemon の events.jsonl を tail し、ESC/q/Ctrl-C か
 * 外部シグナルで renderer が破棄されると promise が resolve する。
 *
 * tail の購読は React の外側 (`LeucoEventLogStore`) で開始する。プロジェクト
 * 規約で `useEffect` が禁止されているため、コンポーネントは
 * `useSyncExternalStore` 経由で store を読むだけになる。
 */
export const launchTui = async (): Promise<void> => {
  const paths = new LeucoPaths()
  const eventStore = new LeucoEventLogStore({})
  const stopTail = tailEventsIntoStore({ store: eventStore, path: paths.daemonEventLogPath() })

  const renderer = await createCliRenderer()
  createRoot(renderer).render(<App eventStore={eventStore} />)

  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
  })

  stopTail()
}
