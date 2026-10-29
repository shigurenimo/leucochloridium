import { parseArguments } from "@/cli/parse-arguments"
import { COMMANDS } from "@/cli/command-catalog"
import { openDaemonLog } from "@/daemon/open-daemon-log"
import { CliError } from "@/cli/cli-error"
import { closeSync } from "node:fs"
import { spawn } from "node:child_process"
import { isProcessAlive, readDaemonLease } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import { createDaemonStartupError } from "@/daemon/create-daemon-startup-error"

export async function startDaemon(home: string, args: string[]): Promise<unknown> {
  const previous = readDaemonLease(home)
  if (previous !== null && isProcessAlive(previous.pid))
    throw new CliError("STATE_CONFLICT", "Leuco is already running or starting")
  const descriptor = openDaemonLog(home)
  const parsed = parseArguments(["start", ...args])
  const optionNames = new Set(
    COMMANDS.find((entry) => entry.name === "start")!.options.map((option) => option.name),
  )
  const childArgs = Object.entries(parsed.flags)
    .filter(([name]) => optionNames.has(name))
    .map(([name, value]) => (value === true ? `--${name}` : `--${name}=${value}`))
  const child = spawn(process.execPath, [process.argv[1]!, "run", "--foreground", ...childArgs], {
    detached: true,
    cwd: process.cwd(),
    env: { ...process.env, LEUCO_HOME: home },
    stdio: ["ignore", descriptor, descriptor],
  })
  closeSync(descriptor)
  const state: {
    error: Error | null
    exited: boolean
    exitCode: number | null
    signal: string | null
  } = { error: null, exited: false, exitCode: null, signal: null }
  child.on("error", (error) => {
    state.error = error
  })
  child.on("exit", (exitCode, signal) => {
    state.exited = true
    state.exitCode = exitCode
    state.signal = signal
  })
  child.unref()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (state.error !== null || state.exited)
      throw createDaemonStartupError({
        home,
        pid: child.pid ?? null,
        exitCode: state.exitCode,
        signal: state.signal,
        spawnError: state.error,
      })
    try {
      const status = await requestDaemon({ home, path: "/status" })
      if (
        typeof status === "object" &&
        status !== null &&
        "pid" in status &&
        status.pid === child.pid &&
        "ready" in status &&
        status.ready === true
      )
        return status
    } catch {
      /* The child has not opened its control socket yet. */
    }
    await Bun.sleep(100)
  }
  throw new CliError(
    "STATE_UNCERTAIN",
    "Leuco is still starting; inspect leuco status and leuco logs (it was not restarted)",
  )
}
