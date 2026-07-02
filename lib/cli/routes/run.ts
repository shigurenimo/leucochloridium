import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoEnv } from "@/env/leuco-env"
import { errorMessage } from "@/error-message"
import { LeucoRuntime } from "@/runtime/runtime"

const help = `leuco run / run in foreground (debug)

usage / leuco run

Logs stream to stdout. SIGINT (Ctrl-C) stops cleanly.`

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
    process.stderr.write(`leuco: ${errorMessage(err)}\n`)
    process.exit(1)
  }

  let stopping = false
  const shutdown = async (signal: string, exitCode = 0): Promise<void> => {
    if (stopping) return
    stopping = true
    process.stdout.write(`\n[leuco] received ${signal}\n`)
    await runtime.stop()
    process.exit(exitCode)
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
      process.stderr.write(`[leuco] reload failed: ${errorMessage(err)}\n`)
    })
  })

  // Log the throw before Node's default crash semantics kick in.
  // `uncaughtExceptionMonitor` runs purely as an observer — it does NOT
  // suppress termination, so the process still exits non-zero and launchd
  // restarts the daemon (`KeepAlive = true`). A real `uncaughtException`
  // handler would silence the crash and leave the process in an undefined
  // state, which is worse than restarting clean.
  process.on("uncaughtExceptionMonitor", (err) => {
    process.stderr.write(`[leuco] uncaughtException: ${errorMessage(err)}\n`)
  })
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(`[leuco] unhandledRejection: ${errorMessage(reason)}\n`)
    // Node's default for unhandledRejection is also abort (since v15), and
    // attaching this listener replaces the default. Exit non-zero so launchd
    // restarts us instead of running with poisoned promise state. The exit
    // code rides through shutdown() itself — a chained .then(exit(1)) would
    // never run because shutdown exits the process.
    void shutdown("unhandledRejection", 1)
  })

  try {
    await runtime.start()
  } catch (err) {
    process.stderr.write(`leuco: ${errorMessage(err)}\n`)
    await runtime.stop().catch(() => undefined)
    process.exit(1)
  }

  // LeucoEngine keeps node alive via plugins + codex stdio. Never resolve so
  // index.ts doesn't append a trailing body line.
  return new Promise<Response>(() => {})
})
