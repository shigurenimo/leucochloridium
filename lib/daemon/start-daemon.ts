import { NodeLeucoStore } from "@/storage/node-leuco-store"
import type { CliArguments } from "@/cli/parse-arguments"
import { COMMANDS, DAEMON_READY_TIMEOUT_MS } from "@/cli/command-catalog"
import { launchDaemonProcess } from "@/daemon/launch-daemon-process"
import { CliError } from "@/cli/cli-error"
import { isProcessAlive, readDaemonLease } from "@/daemon/daemon-lease"
import { waitForDaemonReady } from "@/daemon/wait-for-daemon-ready"
import { createDaemonStartupError } from "@/daemon/create-daemon-startup-error"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { readMaintenanceOperation } from "@/maintenance/read-maintenance-operation"

export async function startDaemon(
  home: string,
  parsed: CliArguments,
  context: { signal?: AbortSignal; requestId?: string } = {},
): Promise<unknown> {
  const signal = context.signal
  signal?.throwIfAborted()
  const previous = readDaemonLease(home)
  if (previous !== null && isProcessAlive(previous.pid))
    throw new CliError("STATE_CONFLICT", "Leuco is already running or starting")
  // Same refusal as status/stop/restart/repair, before the child would hide it as a startup failure.
  assertRecordedDaemonsStopped(
    readMaintenanceOperation(new NodeMaintenanceStore(home)),
    isProcessAlive,
  )
  new NodeLeucoStore(home).ensureHome()
  const optionNames = new Set(
    COMMANDS.find((entry) => entry.name === "start")!.options.map((option) => option.name),
  )
  const childArgs = Object.entries(parsed.flags)
    .filter(([name]) => optionNames.has(name))
    .map(([name, value]) => (value === true ? `--${name}` : `--${name}=${value}`))
  const state = launchDaemonProcess({
    home,
    arguments: [process.argv[1]!, "run", "--foreground", ...childArgs],
    cwd: process.cwd(),
    env: { ...process.env, LEUCO_HOME: home },
  })
  return waitForDaemonReady({
    home,
    pid: state.pid,
    timeoutMs: DAEMON_READY_TIMEOUT_MS,
    requestId: context.requestId,
    signal,
    getExitError: () =>
      state.error !== null || state.exited
        ? createDaemonStartupError({
            home,
            pid: state.pid,
            exitCode: state.exitCode,
            signal: state.signal,
            spawnError: state.error,
          })
        : null,
  })
}
