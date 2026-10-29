import { errorMessage } from "@/error-message"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { readMaintenance } from "@/maintenance/read-maintenance"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { appendDaemonLog } from "@/daemon/append-daemon-log"
import { chmodSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { LeucoRuntime } from "@/runtime/runtime"
import type { LeucoRuntimeProps } from "@/runtime/runtime"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { acquireDaemonLease, releaseDaemonLease } from "@/daemon/daemon-lease"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"

type Props = LeucoRuntimeProps & {
  home: string
  prompt?: string
  requestId?: string
  thread?: string
  signal?: AbortSignal
  quiet?: boolean
  ownsProcess?: boolean
  onReply?: (reply: string) => void
}

export async function runDaemon(props: Props): Promise<void> {
  const store = new NodeLeucoStore(props.home)
  store.ensureHome()
  const settings = store.loadSettings()
  const cwd = props.cwd ?? settings.cwd ?? process.cwd()
  if (!statSync(cwd).isDirectory()) throw new Error("Working directory is not a directory")
  const lease = acquireDaemonLease(props.home)
  const state: { stop: boolean; ready: boolean; resolve: () => void } = {
    stop: false,
    ready: false,
    resolve: () => {},
  }
  const failures: unknown[] = []
  const stopped = new Promise<void>((resolve) => {
    state.resolve = resolve
  })
  const stop = (reason: string, requestId?: string): void => {
    if (state.stop) return
    const message = `Daemon shutdown requested: ${reason}`
    resources.eventLog?.log("info", message, requestId)
    appendDaemonLog(props.home, `${message}${requestId ? ` requestId=${requestId}` : ""}`)
    state.stop = true
    state.ready = false
    state.resolve()
  }
  const onSignal = (reason: string): void => {
    stop(reason)
    void resources.runtime?.stop().catch(() => {})
  }
  const onTerminate = (): void => onSignal("SIGTERM")
  const onInterrupt = (): void => onSignal("SIGINT")
  const onAbort = (): void => onSignal("abort")
  process.on("SIGTERM", onTerminate)
  process.on("SIGINT", onInterrupt)
  const resources: {
    runtime: LeucoRuntime | null
    server: Bun.Server<undefined> | null
    eventLog: LeucoEventLog | null
  } = { runtime: null, server: null, eventLog: null }
  const fatal = (error: unknown): void => {
    if (failures.length === 0)
      failures.push(
        new Error(`Daemon fatal asynchronous failure: ${errorMessage(error)}`, { cause: error }),
      )
    resources.eventLog?.error("Daemon fatal asynchronous failure", error, props.requestId)
    appendDaemonLog(
      props.home,
      `Fatal asynchronous failure: ${resources.eventLog?.redactText(errorMessage(error)) ?? errorMessage(error)}`,
    )
    if (props.ownsProcess && !state.stop) {
      try {
        scheduleRestart(props.home, {}, { requestId: props.requestId, automatic: true })
      } catch (recoveryError) {
        failures.push(recoveryError)
        resources.eventLog?.error(
          "Automatic restart could not be scheduled",
          recoveryError,
          props.requestId,
        )
      }
    }
    onSignal("fatal asynchronous failure")
  }
  process.on("unhandledRejection", fatal)
  process.on("uncaughtException", fatal)
  props.signal?.addEventListener("abort", onAbort, { once: true })
  const textLog: { healthy: boolean; lastErrorAt: number | null } = {
    healthy: true,
    lastErrorAt: null,
  }
  try {
    new NodeMaintenanceStore(props.home).writeLaunch({
      workingDirectory: process.cwd(),
      codexHome: (props.env ?? process.env).CODEX_HOME ?? null,
      ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
      ...(props.soul === undefined ? {} : { soul: props.soul }),
      ...(props.model === undefined ? {} : { model: props.model }),
      ...(props.codexBin === undefined ? {} : { codexBin: props.codexBin }),
    })
    const log = (line: string): void => {
      textLog.healthy = appendDaemonLog(props.home, line)
      if (!textLog.healthy) {
        textLog.lastErrorAt = Date.now()
        resources.eventLog?.log(
          "error",
          "Text log persistence failed; check filesystem space and permissions",
        )
      }
      if (!props.quiet && process.stderr.isTTY) process.stderr.write(`${line}\n`)
    }
    resources.eventLog = new LeucoEventLog({
      eventLogPath: join(props.home, "events.db"),
      onFallback: (event) => {
        textLog.healthy = appendDaemonLog(props.home, JSON.stringify(event))
        if (!textLog.healthy) {
          textLog.lastErrorAt = Date.now()
          throw new Error("Text event fallback persistence failed")
        }
      },
    })
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
      reportError: (error, requestId) => {
        resources.eventLog?.error(`Daemon request failed: ${errorMessage(error)}`, error, requestId)
        return (
          resources.eventLog?.redactText(errorMessage(error)) ??
          "Daemon request failed; inspect logs"
        )
      },
      cwd,
      isReady: () => state.ready,
      getVolatileEvents: (query) => runtime.getVolatileEvents(query),
      getRuntimeStatus: () => ({ ...runtime.getStatus(), textLog: { ...textLog } }),
      getMaintenance: () => readMaintenance(props.home),
      restart: (overrides, requestId) => {
        const operation = scheduleRestart(props.home, overrides, { requestId })
        resources.eventLog?.log("info", `Restart operation accepted: ${operation.id}`, requestId)
        return operation
      },
      runTextTurn: (key, text, requestId) => runtime.runTextTurn(key, text, requestId),
      runSlackCommand: (parsed, upload, requestId) =>
        runtime.runSlackCommand(parsed, upload, requestId),
      stop: (requestId) => stop("control request", requestId),
      awaitStop: () => runtime.stop(),
      ownsProcess: props.ownsProcess,
    })
    resources.server = Bun.serve<undefined>({
      unix: join(props.home, "control.sock"),
      maxRequestBodySize: 101 * 1024 * 1024,
      fetch(request, server) {
        server.timeout(request, 0)
        return handler(request).catch((error: unknown) => {
          const message =
            resources.eventLog?.redactText(errorMessage(error)) ?? "Daemon request failed"
          resources.eventLog?.error(`Unexpected daemon request failure: ${message}`, error)
          return Response.json({ error: message }, { status: 500 })
        })
      },
    })
    chmodSync(join(props.home, "control.sock"), 0o600)
    await runtime.start()
    if (!state.stop) state.ready = true
    log("ready")
    if (props.prompt !== undefined && !state.stop) {
      const reply = await Promise.race([
        runtime.runTextTurn(props.thread ?? "cli", props.prompt, props.requestId),
        stopped.then(() => null),
      ])
      if (reply instanceof Error) throw reply
      if (reply !== null) {
        if (props.onReply) props.onReply(reply)
        else process.stdout.write(`${reply}\n`)
      }
      stop("one-shot complete", props.requestId)
    }
    await stopped
  } catch (error) {
    failures.push(
      error instanceof Error
        ? error
        : new Error(`Daemon execution failed: ${errorMessage(error)}`, { cause: error }),
    )
    resources.eventLog?.error("Daemon execution failed", error, props.requestId)
    appendDaemonLog(
      props.home,
      `Daemon execution failed: ${resources.eventLog?.redactText(errorMessage(error)) ?? errorMessage(error)}`,
    )
  } finally {
    state.ready = false
    const failureCountBeforeCleanup = failures.length
    for (const close of [
      () => resources.runtime?.stop(),
      () => resources.eventLog?.close(),
      () => resources.server?.stop(false),
    ]) {
      try {
        await close()
      } catch (error) {
        failures.push(error)
      }
    }
    try {
      if (failures.length === failureCountBeforeCleanup) releaseDaemonLease(props.home, lease)
      else
        appendDaemonLog(
          props.home,
          "Shutdown incomplete; lease retained until the process exits. Do not start a duplicate.",
        )
    } catch (error) {
      failures.push(error)
    }
    props.signal?.removeEventListener("abort", onAbort)
    process.off("SIGTERM", onTerminate)
    process.off("SIGINT", onInterrupt)
    process.off("unhandledRejection", fatal)
    process.off("uncaughtException", fatal)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1)
    throw new AggregateError(failures, `Daemon failed: ${failures.map(errorMessage).join("; ")}`, {
      cause: failures[0],
    })
}
