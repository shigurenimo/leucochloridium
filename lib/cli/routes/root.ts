import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { formatStatus } from "@/cli/utils/format-status"
import { readCliBody } from "@/cli/utils/read-cli-body"
import { daemonSupervisionWarning, startDaemon } from "@/daemon/daemon-control"
import { cliEnvSchema } from "@/env/cli-env-schema"

/**
 * 引数なしの `leuco` 入口。daemon が既に動いていれば `leuco status` と同じ
 * 出力を返し、動いていなければバックグラウンドで spawn する。`--help` は
 * index.ts 側で横取りされるためここではハンドリングしない。
 */
export const rootHandler = factory.createHandlers(async (c) => {
  await readCliBody(c)

  const { text, isRunning } = formatStatus(c.var.daemon)
  if (isRunning) {
    return c.text(text)
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

  const result = await startDaemon({
    daemon: c.var.daemon,
    binPath: c.var.binPath,
    env: process.env,
  })
  if (result instanceof Error) {
    throw new HTTPException(500, { message: result.message })
  }

  const started =
    result.mode === "launchd"
      ? `leuco: started via launchd (${result.label})`
      : `leuco: started (pid ${result.pid})`
  const lines = [started, `log: ${result.logPath}`]
  const warning = daemonSupervisionWarning(result)
  if (warning !== null) lines.push(warning)
  return c.text(lines.join("\n"))
})
