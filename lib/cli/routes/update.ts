import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { factory } from "@/cli/cli-factory"
import { help } from "@/cli/routes/update.help"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { daemonSupervisionWarning, restartDaemon } from "@/daemon/daemon-control"
import { errorMessage } from "@/error-message"

const registryResponseSchema = z.object({
  version: z.string().min(1),
})

export const updateHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const current = c.var.version
  const latest = await fetchLatestVersion()
  if (latest instanceof Error) {
    throw new HTTPException(500, { message: `${latest.message}` })
  }

  if (latest === current) {
    if (flagBool(body.flags.check)) {
      return c.text(`leuco ${current} (up to date)`)
    }
    return c.text(`leuco ${current} is already the latest`)
  }

  if (flagBool(body.flags.check)) {
    return c.text(`leuco ${current} -> ${latest} available`)
  }

  process.stdout.write(`leuco: updating ${current} -> ${latest}\n`)
  const proc = Bun.spawn([process.execPath, "add", "-g", `leuco@${latest}`], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new HTTPException(500, { message: `bun add -g leuco@${latest} exited with ${code}` })
  }

  // bun add only swaps files in node_modules — the running daemon is still on
  // old code in memory. Restart it so the freshly installed bin is loaded.
  // `isRunning`, not `pid !== null`: a stale pid file must not make update
  // boot a daemon that was never running.
  const daemon = c.var.daemon
  const wasRunning = daemon.status().isRunning
  if (!wasRunning) {
    return c.text(`leuco: updated to ${latest} (daemon not running)`)
  }

  const restarted = await restartDaemon({
    daemon,
    binPath: c.var.binPath,
    env: process.env,
  })
  if (restarted instanceof Error) {
    throw new HTTPException(500, {
      message: `updated to ${latest}, but daemon restart failed: ${errorMessage(restarted)}`,
    })
  }

  const mode =
    restarted.mode === "launchd" ? `via launchd (${restarted.label})` : `(pid ${restarted.pid})`
  const lines = [`leuco: updated to ${latest}, daemon restarted ${mode}`]
  const warning = daemonSupervisionWarning(restarted)
  if (warning !== null) lines.push(warning)
  return c.text(lines.join("\n"))
})

const fetchLatestVersion = async (): Promise<string | Error> => {
  try {
    const res = await fetch("https://registry.npmjs.org/leuco/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return new Error(`registry returned ${res.status}`)
    const json: unknown = await res.json()
    const parsed = registryResponseSchema.safeParse(json)
    if (!parsed.success) return new Error("unexpected registry response")
    return parsed.data.version
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err))
  }
}
