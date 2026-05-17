import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoEnv } from "@/env/leuco-env"
import { LeucoRuntime } from "@/runtime/runtime"

const help = `leuco run — run in foreground (debug)

usage: leuco run

Logs stream to stdout instead of being written to the daemon log file.
Use this to diagnose Slack/codex issues; SIGINT (Ctrl-C) stops cleanly.

Tokens for each channel are read from
~/.leuco/projects/<p>/agents/<a>/channels/<c>/{bot,app}.token at startup.

optional env:
  LEUCO_PORT            HTTP gateway port (default: 7331)`

export const runHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const leucoEnv = new LeucoEnv({ env: process.env })
  const cli = leucoEnv.parseCli()
  if (cli instanceof Error) {
    throw new HTTPException(400, { message: `${cli.message}\nrun \`leuco --help\` for usage.` })
  }

  const envFiles = c.var.envFiles
  if (envFiles.local.loaded || envFiles.base.loaded) {
    const sources: string[] = []
    if (envFiles.local.loaded) sources.push(".env.local")
    if (envFiles.base.loaded) sources.push(".env")
    process.stdout.write(`[leuco] env files: ${sources.join(", ")}\n`)
  }

  let runtime: LeucoRuntime
  try {
    runtime = LeucoRuntime.build({
      env: process.env,
      port: cli.LEUCO_PORT,
      codexBin: cli.LEUCO_CODEX_BIN,
    })
  } catch (err) {
    process.stderr.write(`leuco: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  let stopping = false
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stdout.write(`\n[leuco] received ${signal}\n`)
    await runtime.stop()
    process.exit(0)
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT")
  })
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
  })

  process.on("SIGHUP", () => {
    process.stdout.write("[leuco] received SIGHUP — reconciling tenants\n")
    void runtime.reload().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[leuco] reload failed: ${message}\n`)
    })
  })

  try {
    await runtime.start()
  } catch (err) {
    process.stderr.write(`leuco: ${err instanceof Error ? err.message : String(err)}\n`)
    await runtime.stop().catch(() => undefined)
    process.exit(1)
  }

  // LeucoEngine keeps node alive via plugins + codex stdio. Never resolve so
  // index.ts doesn't append a trailing body line.
  return new Promise<Response>(() => {})
})
