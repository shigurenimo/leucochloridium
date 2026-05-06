import { spawn } from "node:child_process"
import type { LaunchctlPort } from "@/boot/launchctl-port"

type Props = {
  uid?: number
}

type RunResult = {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Default `LaunchctlPort` impl that shells out to `/bin/launchctl` against the
 * current GUI session (`gui/<uid>`). `bootstrap` and `bootout` are idempotent
 * for the common no-op error codes (already loaded / not loaded), surfacing
 * other failures as `Error`.
 */
export class LaunchctlBin implements LaunchctlPort {
  private readonly uid: number

  constructor(props: Props = {}) {
    const fallback = typeof process.getuid === "function" ? process.getuid() : 0
    this.uid = props.uid ?? fallback
    Object.freeze(this)
  }

  async bootstrap(plistPath: string): Promise<void | Error> {
    const result = await runLaunchctl(["bootstrap", this.target(), plistPath])
    if (result instanceof Error) return result
    if (result.exitCode === 0) return undefined
    if (result.exitCode === 37) return undefined

    return new Error(
      `launchctl bootstrap failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }

  async bootout(plistPath: string): Promise<void | Error> {
    const result = await runLaunchctl(["bootout", this.target(), plistPath])
    if (result instanceof Error) return result
    if (result.exitCode === 0) return undefined
    if (result.exitCode === 36) return undefined
    if (result.exitCode === 113) return undefined

    return new Error(
      `launchctl bootout failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }

  async isLoaded(label: string): Promise<boolean | Error> {
    const result = await runLaunchctl(["print", `${this.target()}/${label}`])
    if (result instanceof Error) return result
    if (result.exitCode === 0) return true
    if (result.exitCode === 113) return false

    return new Error(
      `launchctl print failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    )
  }

  private target(): string {
    return `gui/${this.uid}`
  }
}

const runLaunchctl = async (args: string[]): Promise<RunResult | Error> => {
  return new Promise((resolve) => {
    const child = spawn("/bin/launchctl", args, { stdio: ["ignore", "pipe", "pipe"] })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })

    child.on("error", (err) => {
      resolve(err instanceof Error ? err : new Error(String(err)))
    })

    child.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}
