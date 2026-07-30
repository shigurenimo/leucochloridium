import { HTTPException } from "hono/http-exception"
import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { LeucoDaemon } from "@/daemon/leuco-daemon"
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

  const daemon = new LeucoDaemon()
  try {
    daemon.claimCurrentProcess()
  } catch (err) {
    process.stderr.write(`leuco: ${errorMessage(err)}\n`)
    process.exit(1)
  }
  process.once("exit", () => {
    daemon.releaseCurrentProcess()
  })

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
    const stopError = await stopWithin(runtime, SHUTDOWN_TIMEOUT_MS)
    if (stopError !== null) {
      process.stderr.write(`[leuco] shutdown incomplete: ${stopError.message}\n`)
    }
    process.exit(exitCode)
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT")
  })
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM")
  })

  process.on("SIGHUP", () => {
    process.stdout.write("[leuco] received SIGHUP — reconciling project runtimes\n")
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
    // code must ride through `shutdown` itself — it calls `process.exit`
    // internally, so a chained `.then(() => process.exit(1))` never runs.
    // If a signal-driven shutdown is already in flight, let it finish.
    void shutdown("unhandledRejection", 1)
  })

  try {
    await runtime.start()
  } catch (err) {
    process.stderr.write(`leuco: ${errorMessage(err)}\n`)
    await runtime.stop().catch(() => undefined)
    process.exit(1)
  }

  // Project connectors and Codex stdio keep the process alive. Never resolve so
  // index.ts doesn't append a trailing body line.
  return new Promise<Response>(() => {})
})

const SHUTDOWN_TIMEOUT_MS = 12_000

const stopWithin = async (runtime: LeucoRuntime, timeoutMs: number): Promise<Error | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new Error(`runtime stop timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    )
  })
  const stopped = runtime
    .stop()
    .then(() => null)
    .catch((err: unknown) => (err instanceof Error ? err : new Error(errorMessage(err))))

  try {
    return await Promise.race([stopped, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
