import { isProcessAlive, readDaemonLease } from "@/daemon/daemon-lease"
import assert from "node:assert/strict"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"

type TrackedProcess = {
  exitCode: number | null
  exited: Promise<number>
  kill: (signal?: NodeJS.Signals) => void
}

export class VerifierWorkspace {
  readonly path: string
  private readonly daemonHomes = new Set<string>()
  private readonly processes: TrackedProcess[] = []
  private readonly failures: unknown[] = []

  constructor(prefix: string) {
    // Daemon control sockets live inside the workspace, so stay under the short /tmp path limit.
    this.path = realpathSync(mkdtempSync(join("/tmp", prefix)))
  }

  trackDaemon(home: string): void {
    this.daemonHomes.add(home)
  }

  trackProcess(child: TrackedProcess): void {
    this.processes.push(child)
  }

  recordFailure(error: unknown): void {
    this.failures.push(error)
  }

  async close(stop: (home: string) => Promise<unknown>): Promise<void> {
    const cleanupFailures: unknown[] = []
    for (const home of this.daemonHomes) {
      try {
        const lease = readDaemonLease(home)
        if (lease === null || !isProcessAlive(lease.pid)) continue
        assert.notEqual(lease.pid, process.pid, "Refusing to stop the verifier itself")
        await stop(home)
        assert.equal(isProcessAlive(lease.pid), false, `Fixture daemon still alive: ${lease.pid}`)
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    for (const child of this.processes) if (child.exitCode === null) child.kill()
    const timer = setTimeout(() => {
      for (const child of this.processes) if (child.exitCode === null) child.kill("SIGKILL")
    }, 3000)
    try {
      await Promise.allSettled(this.processes.map((child) => child.exited))
    } finally {
      clearTimeout(timer)
    }
    if (cleanupFailures.length === 0) {
      try {
        rmSync(this.path, { recursive: true, force: true })
      } catch (error) {
        cleanupFailures.push(error)
      }
    }
    if (cleanupFailures.length > 0) {
      console.error(`Fixture cleanup unconfirmed; preserving workspace: ${this.path}`)
      throw new AggregateError(
        [...this.failures, ...cleanupFailures],
        `Native fixture cleanup unconfirmed; preserving workspace: ${this.path}`,
      )
    }
    if (this.failures.length > 0) throw this.failures[0]
  }
}
