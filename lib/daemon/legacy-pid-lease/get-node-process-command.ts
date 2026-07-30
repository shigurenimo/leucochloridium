import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

export const getNodeProcessCommand = (pid: number): string | null => {
  if (process.platform === "linux") {
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim()
      return command.length > 0 ? command : null
    } catch {
      return null
    }
  }

  const commandProcess = spawnSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  })
  if (commandProcess.status !== 0) return null

  const command = commandProcess.stdout.trim()
  return command.length > 0 ? command : null
}
