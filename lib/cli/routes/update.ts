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

export const updateHandler = factory.createHandlers(async (context) => {
  const body = await readCliBody(context)
  if (flagBool(body.flags.help)) return context.text(help)

  const current = context.var.version
  const latest = await fetchLatestVersion()
  if (latest instanceof Error) {
    throw new HTTPException(500, { message: latest.message })
  }

  if (latest === current) {
    if (flagBool(body.flags.check)) {
      return context.text(`leuco ${current} (up to date)`)
    }

    return context.text(`leuco ${current} is already the latest`)
  }

  if (flagBool(body.flags.check)) {
    return context.text(`leuco ${current} -> ${latest} available`)
  }

  process.stdout.write(`leuco: updating ${current} -> ${latest}\n`)
  const updateProcess = Bun.spawn([process.execPath, "add", "--global", `leuco@${latest}`], {
    stdio: ["inherit", "inherit", "inherit"],
  })
  const exitCode = await updateProcess.exited
  if (exitCode !== 0) {
    throw new HTTPException(500, {
      message: `bun add --global leuco@${latest} exited with ${exitCode}`,
    })
  }

  const daemon = context.var.daemon
  const wasRunning = daemon.status().isRunning
  if (!wasRunning) {
    return context.text(`leuco: updated to ${latest} (daemon not running)`)
  }

  const restarted = await restartDaemon({
    daemon,
    binPath: context.var.binPath,
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

  return context.text(lines.join("\n"))
})

const fetchLatestVersion = async (): Promise<string | Error> => {
  try {
    const response = await fetch("https://registry.npmjs.org/leuco/latest", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) return new Error(`registry returned ${response.status}`)

    const payload: unknown = await response.json()
    const parsed = registryResponseSchema.safeParse(payload)
    if (!parsed.success) return new Error("unexpected registry response")

    return parsed.data.version
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
