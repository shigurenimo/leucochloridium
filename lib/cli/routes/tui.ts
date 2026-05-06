import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { launchTui } from "@/tui/launch-tui"

const help = `leuco tui — live event viewer

usage: leuco tui

Tails ~/.leuco/daemon/events.jsonl in real time and renders it with
type-aware coloring. When invoked from inside a registered project's path,
defaults to filtering by that project; press 'a' to toggle "show all".

  q   quit
  a   toggle filter (current project / all)`

export const tuiHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  await launchTui()

  // ESC/q/Ctrl-C で renderer が destroy された後、index.ts のフローに戻ると
  // Hono が空ボディの Response を返して終わるため、ここで明示的に終了する。
  process.exit(0)
})
