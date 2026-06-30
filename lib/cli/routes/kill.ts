import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"
import { renderYaml } from "@/cli/utils/render-yaml"

const help = `leuco kill / kill daemon and all codex app-server processes

usage / leuco kill

Sends SIGTERM to the daemon, then finds and kills all remaining
codex app-server processes. Use when \`leuco stop\` leaves orphans.`

type KillReport = {
  daemon: { killed: boolean; pid: number | null }
  codex: { killed: number[]; missed: number[] }
}

const findCodexPids = (): number[] => {
  try {
    const result = Bun.spawnSync(["pgrep", "-f", "codex app-server"], {
      timeout: 5000,
      stdout: "pipe",
      stderr: "pipe",
    })
    const stdout = result.stdout.toString().trim()

    if (stdout.length === 0) return []

    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isFinite(pid))
  } catch {
    return []
  }
}

const killPid = (pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean => {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

const pidIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const GRACE_MS = 3000
const POLL_MS = 100

const waitForExit = (pid: number): boolean => {
  const deadline = Date.now() + GRACE_MS

  while (pidIsAlive(pid)) {
    if (Date.now() >= deadline) return false
    Bun.sleepSync(POLL_MS)
  }

  return true
}

export const killHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  if (flagBool(body.flags.help)) return c.text(help)

  const report: KillReport = {
    daemon: { killed: false, pid: null },
    codex: { killed: [], missed: [] },
  }

  const daemonStatus = c.var.daemon.status()

  if (daemonStatus.isRunning && daemonStatus.pid !== null) {
    const stopped = c.var.daemon.stop()
    report.daemon = { killed: stopped.stopped, pid: stopped.pid }
  } else {
    if (daemonStatus.pid !== null) c.var.daemon.clearStalePid()
    report.daemon = { killed: false, pid: daemonStatus.pid }
  }

  const codexPids = findCodexPids()

  for (const pid of codexPids) {
    killPid(pid, "SIGTERM")
  }

  for (const pid of codexPids) {
    const exited = waitForExit(pid)

    if (exited) {
      report.codex.killed.push(pid)
      continue
    }

    killPid(pid, "SIGKILL")

    if (waitForExit(pid)) {
      report.codex.killed.push(pid)
    } else {
      report.codex.missed.push(pid)
    }
  }

  return c.text(renderYaml(report))
})
