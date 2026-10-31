import { spawn } from "node:child_process"
import { closeSync } from "node:fs"
import { openDaemonLog } from "@/daemon/open-daemon-log"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"

type Props = { home: string; arguments: string[]; cwd: string; env: NodeJS.ProcessEnv }

export function launchDaemonProcess(props: Props) {
  const state: {
    spawned: boolean
    pid: number | null
    error: Error | null
    exited: boolean
    exitCode: number | null
    signal: string | null
  } = {
    spawned: false,
    pid: null,
    error: null,
    exited: false,
    exitCode: null,
    signal: null,
  }
  const descriptor = openDaemonLog(props.home)
  try {
    return withSyncCleanup(
      () => {
        const child = spawn(process.execPath, props.arguments, {
          detached: true,
          cwd: props.cwd,
          env: props.env,
          stdio: ["ignore", descriptor, descriptor],
        })
        state.spawned = true
        state.pid = child.pid ?? null
        child.on("error", (error) => {
          state.error = error
        })
        child.on("exit", (exitCode, signal) => {
          state.exited = true
          state.exitCode = exitCode
          state.signal = signal
        })
        child.unref()
        return state
      },
      () => closeSync(descriptor),
    )
  } catch (cause) {
    if (!state.spawned) throw cause
    const failure = new CliError(
      "STATE_UNCERTAIN",
      `Daemon spawn was requested (PID ${state.pid ?? "unknown"}), but launch setup or log cleanup failed. Inspect status and logs before another start.`,
      { phase: "launch-cleanup", pid: state.pid, causes: errorDetails(cause) },
    )
    failure.cause = cause
    throw failure
  }
}
