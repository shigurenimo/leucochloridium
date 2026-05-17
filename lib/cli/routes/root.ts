import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { readCliBody } from "@/cli/utils/read-cli-body"
import { cliEnvSchema } from "@/env/cli-env-schema"
import { launchTui } from "@/tui/launch-tui"

/**
 * 引数なしの `leuco` 入口。daemon が既に動いていれば TUI に切り替え、
 * 動いていなければバックグラウンドで spawn する。`--help` は index.ts 側で
 * 横取りされるためここではハンドリングしない。
 */
export const rootHandler = factory.createHandlers(async (c) => {
  await readCliBody(c)

  const status = c.var.daemon.status()
  if (status.isRunning) {
    await launchTui()
    process.exit(0)
  }

  const env = cliEnvSchema.safeParse(process.env)
  if (!env.success) {
    const lines = env.error.issues.map((issue) => {
      const key = issue.path.join(".")
      return `${key}: ${issue.message}`
    })
    lines.push("run `leuco --help` for usage.")
    throw new HTTPException(400, { message: lines.join("\n") })
  }

  const result = c.var.daemon.start({ binPath: c.var.binPath, env: process.env })

  return c.text(
    [
      `[leuco] started in background (pid ${result.pid})`,
      `        log: ${result.logPath}`,
      "",
      "run `leuco` again to open the TUI, `leuco stop` to stop.",
    ].join("\n"),
  )
})
