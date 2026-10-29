import type { LeucoEventQuery } from "@/events/leuco-event-query"
import { LeucoConversations } from "@/runtime/leuco-conversations"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"
import { errorDetails } from "@/error-details"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { settingsSchema } from "@/config/config-schema"
import type { LeucoSettings } from "@/config/config-schema"
import type { Connector } from "@/connectors/connector"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoTurnTimeouts } from "@/engine/turn-timeouts"
import { toBoundedCodexNotification } from "@/engine/codex/to-bounded-codex-notification"
import { LeucoEventLog } from "@/events/leuco-event-log"
import { errorMessage } from "@/error-message"
import { buildCodexChildEnv } from "@/runtime/build-codex-child-env"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import type { LeucoStore } from "@/storage/leuco-store"

import { BunCredentialStore } from "@/secrets/bun-credential-store"
import type { CredentialStore } from "@/secrets/credential-store"
import type { SlackCredentials } from "@/secrets/slack-credentials"
import { loadSlackCredentials } from "@/secrets/load-slack-credentials"
import { executeSlackCommand } from "@/actions/slack/execute-slack-command"
import type { CliArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"

export type LeucoRuntimeProps = {
  cwd?: string
  home?: string
  env?: NodeJS.ProcessEnv
  soul?: string | null
  model?: string | null
  codexBin?: string
  onLog?: (line: string) => void
  store?: LeucoStore
  codex?: CodexClientPort
  eventLog?: LeucoEventLog
  connections?: Connector[]
  credentials?: CredentialStore
}

type PendingTurn = {
  requestId: string
  enqueuedAt: number
  key: string
  text: string
  bytes: number
  resolve: (reply: string | Error) => void
}

export class LeucoRuntime {
  readonly instanceId = randomUUID()
  readonly cwd: string
  readonly home: string
  private readonly store: LeucoStore
  private readonly settings: LeucoSettings
  private readonly codex: CodexClientPort
  private readonly eventLog: LeucoEventLog
  private readonly connections: Connector[]
  private readonly conversations: LeucoConversations
  private readonly pending: PendingTurn[] = []
  private slackCredentials: SlackCredentials | null = null
  private activeRequest: {
    requestId: string
    threadKey: string
    startedAt: number
    lastActivityAt: number
    lastActivity: string
  } | null = null
  private lastFailure: {
    ts: number
    requestId: string | null
    phase: string
    message: string
  } | null = null
  private active: Promise<void> | null = null
  private pendingBytes = 0
  private lifecycle: "new" | "starting" | "running" | "stopping" | "stopped" = "new"
  private stopping: Promise<void> | null = null
  private readonly shutdown = Promise.withResolvers<Error>()
  private generation = 0

  private constructor(private readonly props: LeucoRuntimeProps) {
    const env = props.env ?? process.env
    this.home = resolve(props.home ?? env.LEUCO_HOME ?? join(homedir(), ".leuco"))
    this.store = props.store ?? new NodeLeucoStore(this.home)
    this.settings = settingsSchema.parse(this.store.loadSettings())
    this.cwd = resolve(props.cwd ?? this.settings.cwd ?? process.cwd())
    this.eventLog = props.eventLog ?? new LeucoEventLog()
    this.eventLog.setInstanceId(this.instanceId)
    this.codex =
      props.codex ??
      new LeucoCodexClient({
        cwd: this.cwd,
        bin: props.codexBin,
        env: buildCodexChildEnv({ env, home: this.home }),
        onLog: (line) => this.log(line),
        onAnyNotification: (method, params) => {
          const bounded = toBoundedCodexNotification(method, params)
          if (bounded !== null)
            this.eventLog.append({
              ts: Date.now(),
              type: "codex.notification",
              requestId: this.activeRequest?.requestId,
              runtime: "leuco",
              ...bounded,
            })
        },
      })
    this.conversations = new LeucoConversations({
      store: this.store,
      codex: this.codex,
      cwd: this.cwd,
      codexHome: env.CODEX_HOME ?? join(homedir(), ".codex"),
      soul: props.soul === undefined ? this.settings.soul : props.soul,
      model: props.model ?? this.settings.model,
      eventLog: this.eventLog,
    })
    this.connections = [...(props.connections ?? [])]
  }

  getStatus() {
    return {
      instanceId: this.instanceId,
      logs: this.eventLog.getHealth(),
      lifecycle: this.lifecycle,
      codexRunning: this.codex.isRunning(),
      codex: this.codex.getStatus?.() ?? null,
      active: this.activeRequest === null ? null : { ...this.activeRequest },
      queue: {
        waiting: this.pending.length,
        bytes: this.pendingBytes,
        maxWaiting: 64,
        maxBytes: 256 * 1024,
        requests: this.pending.map((entry) => ({
          requestId: entry.requestId,
          threadKey: entry.key,
          enqueuedAt: entry.enqueuedAt,
        })),
      },
      lastFailure: this.lastFailure === null ? null : { ...this.lastFailure },
      connections: this.connections.map((connection) => ({
        ...connection.getIdentity(),
        ...(connection.getStatus ? { health: connection.getStatus() } : {}),
      })),
    }
  }

  getVolatileEvents(query: LeucoEventQuery) {
    if (this.eventLog.getHealth().mode !== "memory-fallback")
      throw new Error("Volatile history is only available while event persistence is unavailable")
    return [...this.eventLog.query({ ...query, order: "desc" })].reverse()
  }

  static build(props: LeucoRuntimeProps = {}): LeucoRuntime {
    return new LeucoRuntime(props)
  }

  async start(): Promise<void> {
    if (this.lifecycle !== "new") throw new Error("Runtime can only start once")
    this.lifecycle = "starting"
    try {
      const slack = this.settings.slack
      const credentials =
        slack === null
          ? null
          : await loadSlackCredentials(
              this.props.credentials ?? new BunCredentialStore(),
              slack.credential,
            )
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      this.slackCredentials = credentials
      if (credentials !== null)
        this.eventLog.setRedactionSecrets([credentials.botToken, credentials.appToken])
      if (this.props.connections === undefined)
        this.connections.push(
          ...buildRuntimeConnections({ settings: this.settings, credentials, store: this.store }),
        )
      await this.codex.start()
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      await this.conversations.initialize()
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      this.lifecycle = "running"
      for (const connection of this.connections) {
        if (this.lifecycle !== "running") throw new Error("Runtime stopped during startup")
        await connection.start({
          cwd: this.cwd,
          runtimeName: "leuco",
          eventLog: this.eventLog,
          onLog: (line) => this.log(line),
          runTextTurn: (key, text, requestId) => this.runTextTurn(key, text, requestId),
        })
        if (this.lifecycle !== "running") {
          await connection.stop()
          throw new Error("Runtime stopped during startup")
        }
      }
      this.eventLog.append({ ts: Date.now(), type: "runtime.started", runtime: "leuco" })
    } catch (error) {
      this.lastFailure = {
        ts: Date.now(),
        requestId: null,
        phase: "startup",
        message: this.eventLog.redactText(errorMessage(error)),
      }
      this.eventLog.error(`Runtime startup failed: ${this.lastFailure.message}`, error)
      try {
        await this.stop()
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          `Runtime startup failed: ${errorMessage(error)}; cleanup also failed`,
          { cause: error },
        )
      }
      throw error
    }
  }

  async runSlackCommand(
    parsed: CliArguments,
    upload?: Uint8Array,
    requestId: string = randomUUID(),
  ): Promise<unknown> {
    validateCommand(parsed)
    if (
      parsed.words[0] !== "slack" ||
      !["call", "upload-file", "download-file"].includes(parsed.words[1] ?? "")
    )
      throw new Error("Unsupported Slack operation")
    if (this.lifecycle !== "running") throw new Error("Runtime is not running")
    if (this.slackCredentials === null)
      throw new Error(
        "Slack is not configured; stop Leuco, copy each token, and run leuco slack login bot / leuco slack login app",
      )
    const startedAt = Date.now()
    this.eventLog.log(
      "info",
      `Slack operation started: ${parsed.words.slice(1).join(" ")}`,
      requestId,
    )
    try {
      const reply = await executeSlackCommand({
        parsed,
        botToken: this.slackCredentials.botToken,
        upload,
      })
      if (this.lifecycle !== "running") {
        if (reply instanceof Response) await reply.body?.cancel().catch(() => {})
        throw new Error("Runtime stopped during Slack operation")
      }
      return reply instanceof Response
        ? reply
        : JSON.parse(this.eventLog.redactText(JSON.stringify(reply)))
    } catch (error) {
      const message = this.eventLog.redactText(errorMessage(error))
      this.lastFailure = { ts: Date.now(), requestId, phase: "slack", message }
      this.eventLog.error(
        `Slack operation failed after ${Date.now() - startedAt} ms: ${message}`,
        error,
        requestId,
      )
      throw new Error(message, { cause: error })
    } finally {
      this.eventLog.log(
        "info",
        `Slack operation finished after ${Date.now() - startedAt} ms`,
        requestId,
      )
    }
  }

  runTextTurn(
    key: string,
    text: string,
    requestId: string = randomUUID(),
  ): Promise<string | Error> {
    const bytes = Buffer.byteLength(text, "utf8")
    const rejected =
      this.lifecycle !== "running"
        ? "runtime_stopped"
        : this.pending.length >= 64
          ? "queue_count_limit"
          : this.pendingBytes + bytes > 256 * 1024
            ? "queue_bytes_limit"
            : null
    if (rejected !== null) {
      this.eventLog.append({
        ts: Date.now(),
        type: "turn.rejected",
        runtime: "leuco",
        threadKey: key,
        requestId,
        reason: rejected,
        queueDepth: this.pending.length,
        queueBytes: this.pendingBytes,
        inputBytes: bytes,
        maxQueueDepth: 64,
        maxQueueBytes: 256 * 1024,
      })
      return Promise.resolve(
        new Error(
          rejected === "runtime_stopped"
            ? "Runtime is not running"
            : "Turn queue is full; retry after the current work finishes",
        ),
      )
    }
    if (!key || key.length > 512)
      return Promise.resolve(new Error("Thread key must contain 1-512 characters"))
    return new Promise((resolveReply) => {
      this.pending.push({
        key,
        text,
        bytes,
        requestId,
        enqueuedAt: Date.now(),
        resolve: resolveReply,
      })
      this.eventLog.append({
        ts: Date.now(),
        type: "turn.queued",
        runtime: "leuco",
        threadKey: key,
        requestId,
        queueDepth: this.pending.length,
        queueBytes: this.pendingBytes + bytes,
      })
      this.pendingBytes += bytes
      this.drain()
    })
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping
    this.lifecycle = "stopping"
    this.shutdown.resolve(new Error("Runtime stopped"))
    this.generation += 1
    for (const turn of this.pending.splice(0)) {
      this.eventLog.append({
        ts: Date.now(),
        type: "turn.error",
        requestId: turn.requestId,
        runtime: "leuco",
        threadKey: turn.key,
        error: "Runtime stopped before execution",
        cancelled: true,
      })
      turn.resolve(new Error("Runtime stopped"))
    }
    this.pendingBytes = 0
    this.stopping = this.close()
    return this.stopping
  }

  private async close(): Promise<void> {
    const failures: Error[] = []
    const resources = [
      { name: "Codex process", close: () => this.codex.stop() },
      ...this.connections.map((connection) => ({
        name: `connector ${connection.name}`,
        close: () => connection.stop(),
      })),
      { name: "active request", close: () => this.active },
    ]
    const outcomes = await Promise.allSettled(
      resources.map((resource) => Promise.resolve().then(resource.close)),
    )
    for (const index of outcomes.keys()) {
      const outcome = outcomes[index]!
      if (outcome.status === "rejected") {
        const failure = new Error(
          `Runtime shutdown failed for ${resources[index]!.name}: ${errorMessage(outcome.reason)}`,
          { cause: outcome.reason },
        )
        failures.push(failure)
        this.eventLog.error(failure.message, outcome.reason)
        this.lastFailure = {
          ts: Date.now(),
          requestId: null,
          phase: "shutdown",
          message: this.eventLog.redactText(failure.message),
        }
      }
    }
    this.slackCredentials = null
    this.connections.splice(0)
    this.lifecycle = "stopped"
    this.eventLog.append({ ts: Date.now(), type: "runtime.stopped", runtime: "leuco" })
    try {
      this.eventLog.close()
    } catch (error) {
      failures.push(new Error(`Event log close failed: ${errorMessage(error)}`, { cause: error }))
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        `Runtime shutdown failed: ${failures.map((error) => error.message).join("; ")}`,
        {
          cause: failures[0],
        },
      )
  }

  private drain(): void {
    if (this.active !== null || this.lifecycle !== "running") return
    const turn = this.pending.shift()
    if (turn === undefined) return
    this.pendingBytes -= turn.bytes
    this.active = this.execute(turn)
      .then(turn.resolve, (error: unknown) => {
        this.eventLog.error("Unexpected turn lifecycle failure", error, turn.requestId)
        turn.resolve(error instanceof Error ? error : new Error(errorMessage(error)))
      })
      .finally(() => {
        this.active = null
        this.drain()
      })
  }

  private async execute(turn: PendingTurn): Promise<string | Error> {
    const timeouts = new LeucoTurnTimeouts({
      hardTimeoutMs: this.settings.turnTimeoutMs,
      idleTimeoutMs: this.settings.idleTimeoutMs,
      clock: { setTimeout, clearTimeout },
    })
    const startedAt = Date.now()
    this.activeRequest = {
      requestId: turn.requestId,
      threadKey: turn.key,
      startedAt,
      lastActivityAt: startedAt,
      lastActivity: "thread initialization",
    }
    this.eventLog.append({
      ts: startedAt,
      type: "turn.start",
      requestId: turn.requestId,
      queueWaitMs: startedAt - turn.enqueuedAt,
      runtime: "leuco",
      threadKey: turn.key,
      input: turn.text,
    })
    try {
      const reply = await Promise.race([
        this.runCodex(turn, timeouts, this.generation),
        timeouts.hardTimeout,
        timeouts.idleTimeout,
        this.shutdown.promise,
      ]).catch((error: unknown) =>
        error instanceof Error ? error : new Error(errorMessage(error)),
      )
      if (reply instanceof Error) {
        this.generation += 1
        if (this.lifecycle === "running")
          this.lastFailure = {
            ts: Date.now(),
            requestId: turn.requestId,
            phase: "turn",
            message: this.eventLog.redactText(reply.message),
          }
        this.eventLog.append({
          ts: Date.now(),
          type: "turn.error",
          cancelled: this.lifecycle !== "running",
          requestId: turn.requestId,
          durationMs: Date.now() - startedAt,
          runtime: "leuco",
          threadKey: turn.key,
          error: reply.message,
          causes: errorDetails(reply),
          phase: this.activeRequest?.lastActivity,
        })
        if (this.lifecycle === "running") {
          try {
            await this.codex.stop()
          } catch (cleanup) {
            this.eventLog.error(
              "Codex cleanup failed after a turn failure",
              cleanup,
              turn.requestId,
            )
            return new AggregateError(
              [reply, cleanup],
              `${reply.message}; Codex cleanup failed: ${errorMessage(cleanup)}`,
              { cause: reply },
            )
          }
        }
        this.conversations.clearLiveThreads()
      } else {
        this.eventLog.append({
          ts: Date.now(),
          type: "turn.complete",
          requestId: turn.requestId,
          runtime: "leuco",
          threadKey: turn.key,
          reply,
          durationMs: Date.now() - startedAt,
        })
      }
      return reply
    } finally {
      this.activeRequest = null
      timeouts.clear()
    }
  }

  private async runCodex(
    turn: PendingTurn,
    timeouts: LeucoTurnTimeouts,
    generation: number,
  ): Promise<string | Error> {
    if (!this.codex.isRunning()) {
      this.eventLog.log(
        "info",
        "Reconnecting Codex for the next request; previous work is not replayed",
        turn.requestId,
      )
      await this.codex.start()
      this.conversations.clearLiveThreads()
      if (this.lifecycle !== "running") return new Error("Runtime stopped")
    }
    if (generation !== this.generation) return new Error("Turn was cancelled")
    const threadId = await this.conversations.ensure(turn.key, {
      requestId: turn.requestId,
      isCurrent: () => generation === this.generation && this.lifecycle === "running",
      activity: (phase) => {
        if (this.activeRequest?.requestId === turn.requestId) {
          this.activeRequest.lastActivity = phase
          this.activeRequest.lastActivityAt = Date.now()
        }
      },
    })
    if (threadId instanceof Error) return threadId
    if (this.lifecycle !== "running" || generation !== this.generation)
      return new Error("Runtime stopped or turn cancelled")
    timeouts.startIdle()
    if (this.activeRequest) this.activeRequest.lastActivity = "executing Codex turn"
    return this.codex.runTextTurn(threadId, turn.text, {
      cwd: this.cwd,
      onActivity: (method) => {
        timeouts.activity()
        if (this.activeRequest?.requestId === turn.requestId) {
          this.activeRequest.lastActivityAt = Date.now()
          this.activeRequest.lastActivity = method
        }
      },
    })
  }

  private log(line: string): void {
    const safe = this.eventLog.redactText(line)
    this.eventLog.log("info", safe, this.activeRequest?.requestId)
    try {
      this.props.onLog?.(safe)
    } catch (error) {
      this.eventLog.error(
        `Log consumer failed: ${errorMessage(error)}`,
        error,
        this.activeRequest?.requestId,
      )
      process.stderr.write("leuco: log consumer failed; inspect structured events\n")
    }
  }
}
