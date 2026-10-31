import { MAX_CONTROL_MULTIPART_BYTES } from "@/daemon/control-input-limits"
import { reportDaemonRequestFailure } from "@/daemon/report-daemon-request-failure"
import { formatLogLine } from "@/format-log-line"
import { errorMessage } from "@/error-message"
import type { LogLevel } from "@/log-level"
import { NodeMaintenanceStore } from "@/maintenance/node-maintenance-store"
import { readMaintenance } from "@/maintenance/read-maintenance"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { DaemonTextLog } from "@/daemon/daemon-text-log"
import { chmodSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { LeucoRuntime } from "@/runtime/runtime"
import type { LeucoRuntimeProps } from "@/runtime/runtime"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { acquireDaemonLease, releaseDaemonLease } from "@/daemon/daemon-lease"
import { handleDaemonRequest } from "@/daemon/handle-daemon-request"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { errorDetails } from "@/error-details"

type Props = Omit<LeucoRuntimeProps, "store" | "eventLog" | "onLog"> & {
  home: string
  requestId?: string
  signal?: AbortSignal
  ownsProcess?: boolean
}

export async function runDaemon(props: Props): Promise<void> {
  const store = new NodeLeucoStore(props.home)
  store.ensureHome()
  const settings = store.loadSettings()
  const cwd = props.cwd ?? settings.cwd ?? process.cwd()
  if (!statSync(cwd).isDirectory()) throw new Error("Working directory is not a directory")
  const lease = acquireDaemonLease(props.home)
  const state: {
    stop: boolean
    ready: boolean
    resolve: () => void
    shutdownRequestId: string | undefined
  } = {
    stop: false,
    ready: false,
    resolve: () => {},
    shutdownRequestId: undefined,
  }
  const failures: unknown[] = []
  const textLog = new DaemonTextLog({ home: props.home })
  const stopped = new Promise<void>((resolve) => {
    state.resolve = resolve
  })
  const stop = (reason: string, requestId?: string): void => {
    if (state.stop) return
    const message = `Daemon shutdown requested: ${reason}`
    resources.eventLog?.log("info", message, requestId)
    textLog.write(`${message}${requestId ? ` requestId=${requestId}` : ""}`)
    state.stop = true
    state.shutdownRequestId = requestId
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
    textLog.write(
      `Fatal asynchronous failure: ${resources.eventLog?.redactText(errorMessage(error)) ?? errorMessage(error)}`,
    )
    if (props.ownsProcess && !state.stop) {
      try {
        scheduleRestart(
          props.home,
          {},
          { requestId: props.requestId, automatic: true, expectedLease: lease },
        )
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
  try {
    new NodeMaintenanceStore(props.home).writeLaunch({
      workingDirectory: process.cwd(),
      codexHome: (props.env ?? process.env).CODEX_HOME ?? null,
      ...(props.cwd === undefined ? {} : { cwd: props.cwd }),
      ...(props.soul === undefined ? {} : { soul: props.soul }),
    })
    const log = (line: string, level: LogLevel = "info", requestId?: string): void => {
      const record = `[${level}]${requestId ? ` requestId=${requestId}` : ""} ${line}`
      const failure = textLog.write(record)
      if (failure !== null)
        resources.eventLog?.error(
          "Text log persistence failed; inspect runtime.textLog.lastFailure",
          failure,
          requestId,
        )
      if (process.stderr.isTTY) process.stderr.write(`${formatLogLine(record)}\n`)
    }
    resources.eventLog = new LeucoEventLog({
      eventLogPath: join(props.home, "events.db"),
      onFallback: (event) => {
        const failure = textLog.write(JSON.stringify(event))
        if (failure !== null)
          throw new Error("Text event fallback persistence failed", { cause: failure })
      },
    })
    resources.eventLog.addRedactionSecrets([lease.token])
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
      reportError: (error, requestId) =>
        resources.eventLog
          ? reportDaemonRequestFailure(resources.eventLog, error, requestId)
          : "Daemon request failed; inspect logs",
      cwd,
      isReady: () => state.ready,
      getVolatileEvents: (query) => runtime.getVolatileEvents(query),
      getRuntimeStatus: () => ({
        ...runtime.getStatus(),
        textLog: textLog.getHealth(),
        control: { pendingRequests: resources.server?.pendingRequests ?? 0 },
      }),
      getMaintenance: () => readMaintenance(props.home),
      restart: (overrides, requestId) => {
        const operation = scheduleRestart(props.home, overrides, {
          requestId,
          expectedLease: lease,
        })
        resources.eventLog?.log("info", `Restart operation accepted: ${operation.id}`, requestId)
        return operation
      },
      runTextTurn: (key, text, requestId) => runtime.runTextTurn(key, text, requestId),
      runSlackCommand: (parsed, options) => runtime.runSlackCommand(parsed, options),
      stop: (requestId) => stop("control request", requestId),
      awaitStop: () => runtime.stop(),
      ownsProcess: props.ownsProcess,
    })
    resources.server = Bun.serve<undefined>({
      unix: join(props.home, "control.sock"),
      maxRequestBodySize: MAX_CONTROL_MULTIPART_BYTES,
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
    await stopped
  } catch (error) {
    failures.push(
      error instanceof Error
        ? error
        : new Error(`Daemon execution failed: ${errorMessage(error)}`, { cause: error }),
    )
    resources.eventLog?.error("Daemon execution failed", error, props.requestId)
    textLog.write(
      `Daemon execution failed: ${resources.eventLog?.redactText(errorMessage(error)) ?? errorMessage(error)}`,
    )
  } finally {
    state.ready = false
    const failureCountBeforeCleanup = failures.length
    const closeControlServer = async (): Promise<void> => {
      const server = resources.server
      if (server === null) return
      try {
        await awaitBoundedCleanup(server.stop(false), "Control server graceful drain", 1000)
      } catch (drain) {
        const pendingRequests = server.pendingRequests
        try {
          await awaitBoundedCleanup(server.stop(true), "Control server forced shutdown", 1000)
        } catch (forced) {
          throw new AggregateError([drain, forced], "Control server shutdown was not confirmed", {
            cause: drain,
          })
        }
        const requestId = state.shutdownRequestId ?? props.requestId
        const message = `Control server force-closed ${pendingRequests} pending requests after graceful drain failed: ${errorMessage(drain)}`
        resources.eventLog?.append({
          ts: Date.now(),
          type: "log",
          level: "warn",
          line: message,
          causes: errorDetails(drain),
          requestId,
        })
        textLog.write(`${message}${requestId ? ` requestId=${requestId}` : ""}`)
      }
    }
    for (const close of [
      () => resources.runtime?.stop(),
      closeControlServer,
      () => resources.eventLog?.close(),
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
        textLog.write(
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
