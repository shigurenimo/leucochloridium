/** @jsxImportSource @opentui/react */
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { LeucoPaths } from "@/paths/leuco-paths"
import { App } from "@/tui/app"

/**
 * TUI を起動する。daemon の events.jsonl を tail し、ESC/q/Ctrl-C か
 * 外部シグナルで renderer が破棄されると promise が resolve する。
 */
export const launchTui = async (): Promise<void> => {
  const paths = new LeucoPaths()

  const renderer = await createCliRenderer()
  createRoot(renderer).render(<App eventLogPath={paths.daemonEventLogPath()} />)

  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
  })
}
