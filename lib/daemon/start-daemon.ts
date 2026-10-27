import { closeSync, openSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { isProcessAlive, readDaemonLease } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"

export async function startDaemon(home: string, args: string[]): Promise<unknown> {
  const previous = readDaemonLease(home)
  if (previous !== null && isProcessAlive(previous.pid))
    throw new Error("Leuco is already running or starting")
  const descriptor = openSync(join(home, "daemon.log"), "a", 0o600)
  const child = spawn(process.execPath, [process.argv[1]!, "run", ...args], {
    detached: true,
    cwd: process.cwd(),
    env: { ...process.env, LEUCO_HOME: home },
    stdio: ["ignore", descriptor, descriptor],
  })
  closeSync(descriptor)
  const state: { error: Error | null; exited: boolean } = { error: null, exited: false }
  child.on("error", (error) => {
    state.error = error
  })
  child.on("exit", () => {
    state.exited = true
  })
  child.unref()
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (state.error !== null) throw state.error
    if (state.exited) throw new Error("Leuco failed to start; inspect leuco logs")
    try {
      const status = await requestDaemon(home, "/status")
      if (
        typeof status === "object" &&
        status !== null &&
        "ready" in status &&
        status.ready === true
      )
        return status
    } catch {
      /* The child has not opened its control socket yet. */
    }
    await Bun.sleep(100)
  }
  throw new Error(
    "Leuco is still starting; inspect leuco status and leuco logs (it was not restarted)",
  )
}
