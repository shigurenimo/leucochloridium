import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { formatStatus } from "@/cli/utils/format-status"
import { readCliBody } from "@/cli/utils/read-cli-body"
import { cliEnvSchema } from "@/env/cli-env-schema"

/**
 * 引数なしの `leuco` 入口。daemon が既に動いていれば `leuco status` と同じ
 * 出力を返し、動いていなければバックグラウンドで spawn する。`--help` は
 * index.ts 側で横取りされるためここではハンドリングしない。
 */
export const rootHandler = factory.createHandlers(async (c) => {
  await readCliBody(c)

  const { lines, isRunning } = formatStatus(c.var.daemon)
  if (isRunning) {
    return c.text(lines.join("\n"))
  }

  const env = cliEnvSchema.safeParse(process.env)
  if (!env.success) {
    const issues = env.error.issues.map((issue) => {
      const key = issue.path.join(".")
      return `${key}: ${issue.message}`
    })
    issues.push("run `leuco --help` for usage.")
    throw new HTTPException(400, { message: issues.join("\n") })
  }

  const result = c.var.daemon.start({ binPath: c.var.binPath, env: process.env })

  return c.text(
    [
      `[leuco] started in background (pid ${result.pid})`,
      `        log: ${result.logPath}`,
      "",
      "run `leuco status` to inspect, `leuco stop` to stop.",
    ].join("\n"),
  )
})
