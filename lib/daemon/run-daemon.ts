import { appendFileSync, chmodSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { LeucoRuntime } from "@/runtime/runtime"
import type { LeucoRuntimeProps } from "@/runtime/runtime"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { acquireDaemonLease, releaseDaemonLease } from "@/daemon/daemon-lease"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"

type Props = LeucoRuntimeProps & { home: string; prompt?: string; thread?: string }

export async function runDaemon(props: Props): Promise<void> {
  const store = new NodeLeucoStore(props.home)
  store.ensureHome()
  const settings = store.loadSettings()
  const cwd = props.cwd ?? settings.cwd ?? process.cwd()
  if (!statSync(cwd).isDirectory()) throw new Error("Working directory is not a directory")
  const lease = acquireDaemonLease(props.home)
  const state = { stop: false, ready: false, resolve: (): void => {} }
  const stopped = new Promise<void>((resolve) => {
    state.resolve = resolve
  })
  const stop = (): void => {
    state.stop = true
    state.ready = false
    state.resolve()
  }
  const onSignal = (): void => stop()
  process.on("SIGTERM", onSignal)
  process.on("SIGINT", onSignal)
  const resources: {
    runtime: LeucoRuntime | null
    server: Bun.Server<undefined> | null
    eventLog: LeucoEventLog | null
  } = { runtime: null, server: null, eventLog: null }
  try {
    const logPath = join(props.home, "daemon.log")
    const log = (line: string): void => {
      appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 })
      if (process.stdout.isTTY) process.stdout.write(`${line}\n`)
    }
    resources.eventLog = new LeucoEventLog({ eventLogPath: join(props.home, "events.db") })
    for (const suffix of ["", "-wal", "-shm"]) {
      const path = join(props.home, `events.db${suffix}`)
      if (existsSync(path)) chmodSync(path, 0o600)
    }
    const runtime = LeucoRuntime.build({
      ...props,
      cwd,
      store,
      eventLog: resources.eventLog,
      onLog: log,
    })
    resources.runtime = runtime
    const handler = handleDaemonRequest({
      token: lease.token,
      cwd,
      isReady: () => state.ready,
      runTextTurn: (key, text) => runtime.runTextTurn(key, text),
      runSlackCommand: (parsed, upload) => runtime.runSlackCommand(parsed, upload),
      stop,
    })
    resources.server = Bun.serve<undefined>({
      unix: join(props.home, "control.sock"),
      maxRequestBodySize: 101 * 1024 * 1024,
      fetch(request, server) {
        server.timeout(request, 0)
        return handler(request)
      },
    })
    chmodSync(join(props.home, "control.sock"), 0o600)
    await runtime.start()
    if (!state.stop) state.ready = true
    log("ready")
    if (props.prompt !== undefined && !state.stop) {
      const reply = await Promise.race([
        runtime.runTextTurn(props.thread ?? "cli", props.prompt),
        stopped.then(() => null),
      ])
      if (reply instanceof Error) throw reply
      if (reply !== null) process.stdout.write(`${reply}\n`)
      stop()
    }
    await stopped
  } finally {
    state.ready = false
    try {
      await resources.runtime?.stop()
    } finally {
      try {
        resources.eventLog?.close()
      } finally {
        try {
          await resources.server?.stop(false)
        } finally {
          releaseDaemonLease(props.home, lease)
          process.off("SIGTERM", onSignal)
          process.off("SIGINT", onSignal)
        }
      }
    }
  }
}
