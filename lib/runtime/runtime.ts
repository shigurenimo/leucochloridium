import type { DiscordCredentials } from "@/secrets/discord-credentials"
import { loadDiscordCredentials } from "@/secrets/load-discord-credentials"
import { executeDiscordCommand } from "@/actions/discord/execute-discord-command"
import { validateDiscordCommand } from "@/cli/validate-discord-command"
import { LeucoLogConsumer } from "@/runtime/leuco-log-consumer"
import { MAX_THREAD_KEY_CHARACTERS, MAX_TURN_INPUT_BYTES } from "@/turn-input-limits"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import type { LogLevel } from "@/log-level"
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
import { leucoHomeSchema } from "@/config/leuco-home-schema"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import type { LeucoStore } from "@/storage/leuco-store"

import { BunCredentialStore } from "@/secrets/bun-credential-store"
import type { CredentialStore } from "@/secrets/credential-store"
import type { SlackCredentials } from "@/secrets/slack-credentials"
import { loadSlackCredentials } from "@/secrets/load-slack-credentials"
import { executeSlackCommand } from "@/actions/slack/execute-slack-command"
import type { CliArguments } from "@/cli/parse-arguments"
import { validateSlackCommand } from "@/cli/validate-slack-command"
import type { SlackCommandOptions } from "@/runtime/slack-command-options"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { assertSlackReplyActive } from "@/runtime/assert-slack-reply-active"

export type LeucoRuntimeProps = {
  cwd?: string
  home?: string
  env?: NodeJS.ProcessEnv
  soul?: string | null
  codexBin?: string
  onLog?: (line: string, level?: LogLevel, requestId?: string) => void
  store?: LeucoStore
  codex?: CodexClientPort
  /** Caller-owned when supplied; close it after all users finish shutdown. */
  eventLog?: LeucoEventLog
  connections?: Connector[]
  credentials?: CredentialStore
}

type PendingTurn = {
  requestId: string
  enqueuedAt: number
  enqueuedTick: number
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
  private readonly ownsEventLog: boolean
  private readonly logConsumer: LeucoLogConsumer
  private readonly connections: Connector[]
  private readonly credentialStore: CredentialStore
  private readonly usesDefaultConnections: boolean
  private readonly conversations: LeucoConversations
  private readonly pending: PendingTurn[] = []
  private discordCredentials: DiscordCredentials | null = null
  private slackCredentials: SlackCredentials | null = null
  private readonly slackShutdown = new AbortController()
  private readonly slackOperations = new Map<
    Promise<unknown>,
    {
      requestId: string
      action: string
      startedAt: number
      startedTick: number
      signal: AbortSignal
    }
  >()
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

  private constructor(props: LeucoRuntimeProps) {
    const env = props.env ?? process.env
    this.credentialStore = props.credentials ?? new BunCredentialStore()
    this.home = leucoHomeSchema.parse(props.home ?? env.LEUCO_HOME)
    this.store = props.store ?? new NodeLeucoStore(this.home)
    this.settings = settingsSchema.parse(this.store.loadSettings())
    this.cwd = resolve(props.cwd ?? this.settings.cwd ?? process.cwd())
    this.ownsEventLog = props.eventLog === undefined
    this.eventLog = props.eventLog ?? new LeucoEventLog()
    this.eventLog.setInstanceId(this.instanceId)
    this.logConsumer = new LeucoLogConsumer({ eventLog: this.eventLog, onLog: props.onLog })
    this.codex =
      props.codex ??
      new LeucoCodexClient({
        cwd: this.cwd,
        bin: props.codexBin,
        env: buildCodexChildEnv({ env, home: this.home }),
        onLog: (line, level) => this.log(line, level),
        redactLogText: (line) => this.eventLog.redactText(line),
        onAnyNotification: (method, params, requestId) => {
          const bounded = toBoundedCodexNotification(method, params, {
            text: (value) => this.eventLog.redactText(value),
            value: (value) => this.eventLog.redactValue(value),
          })
          if (bounded !== null)
            this.eventLog.append({
              ts: Date.now(),
              type: "codex.notification",
              requestId,
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
      model: this.settings.model,
      eventLog: this.eventLog,
    })
    const connections = props.connections
    this.usesDefaultConnections = connections === undefined
    this.connections = [...(connections ?? [])]
  }

  getStatus() {
    return {
      instanceId: this.instanceId,
      logs: this.eventLog.getHealth(),
      logConsumer: this.logConsumer.getHealth(),
      lifecycle: this.lifecycle,
      codexRunning: this.codex.isRunning(),
      codex: structuredClone(this.codex.getStatus?.() ?? null),
      active: this.activeRequest === null ? null : { ...this.activeRequest },
      slack: {
        active: this.slackOperations.size,
        requests: Array.from(this.slackOperations.values(), (operation) => ({
          requestId: operation.requestId,
          action: operation.action,
          startedAt: operation.startedAt,
          elapsedMs: Math.max(0, Math.round(performance.now() - operation.startedTick)),
          cancellationRequested: operation.signal.aborted,
        })),
      },
      queue: {
        waiting: this.pending.length,
        bytes: this.pendingBytes,
        maxWaiting: 64,
        maxBytes: MAX_TURN_INPUT_BYTES,
        requests: this.pending.map((entry) => ({
          requestId: entry.requestId,
          threadKey: entry.key,
          enqueuedAt: entry.enqueuedAt,
        })),
      },
      lastFailure: this.lastFailure === null ? null : { ...this.lastFailure },
      connections: this.connections.map((connection) => ({
        ...connection.getIdentity(),
        ...(connection.getStatus ? { health: structuredClone(connection.getStatus()) } : {}),
      })),
    }
  }

  getVolatileEvents(query: LeucoEventQuery) {
    if (this.eventLog.getHealth().mode === "sqlite")
      throw new Error("Volatile history is only available for memory event storage")
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
        slack === null ? null : await loadSlackCredentials(this.credentialStore, slack.credential)
      const discord = this.settings.discord
      const discordCredentials =
        discord === null
          ? null
          : await loadDiscordCredentials(this.credentialStore, discord.credential)
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      this.slackCredentials = credentials
      this.discordCredentials = discordCredentials
      if (discordCredentials !== null)
        this.eventLog.addRedactionSecrets([discordCredentials.botToken])
      if (credentials !== null)
        this.eventLog.addRedactionSecrets([credentials.botToken, credentials.appToken])
      if (this.usesDefaultConnections)
        this.connections.push(
          ...buildRuntimeConnections({
            settings: this.settings,
            credentials,
            discordCredentials,
            store: this.store,
          }),
        )
      await this.codex.start()
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      await this.conversations.initialize()
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      this.lifecycle = "running"
      for (const connection of this.connections) {
        if (this.lifecycle !== "running") throw new Error("Runtime stopped during startup")
        await connection.start({
          eventLog: this.eventLog,
          onLog: (line, level, requestId) => this.log(line, level, requestId ?? null),
          onTextLog: (line, level = "info", requestId) =>
            this.logConsumer.write(this.eventLog.redactText(line), level, requestId ?? null),
          runTextTurn: (key, text, requestId) => this.runTextTurn(key, text, requestId),
        })
        if (this.lifecycle !== "running") {
          await connection.stop()
          throw new Error("Runtime stopped during startup")
        }
      }
      this.eventLog.append({ ts: Date.now(), type: "runtime.started" })
      if (this.lifecycle !== "running") throw new Error("Runtime stopped during startup")
    } catch (error) {
      this.lastFailure = {
        ts: Date.now(),
        requestId: null,
        phase: "startup",
        message: this.eventLog.redactError(error).message,
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

  async runDiscordCommand(
    parsed: CliArguments,
    requestId: string = randomUUID(),
  ): Promise<unknown> {
    validateDiscordCommand(parsed)
    if (parsed.words[0] !== "discord" || parsed.words[1] !== "call")
      throw new Error("Unsupported Discord operation")
    if (this.lifecycle !== "running") throw new Error("Runtime is not running")
    if (this.discordCredentials === null)
      throw new Error(
        "Discord is not configured; stop Leuco, copy the bot token and run leuco discord login",
      )
    try {
      const reply = await executeDiscordCommand({
        parsed,
        botToken: this.discordCredentials.botToken,
      })
      if (this.lifecycle !== "running") throw new Error("Runtime stopped during Discord operation")
      return this.eventLog.redactValue(reply)
    } catch (error) {
      const message = this.eventLog.redactText(errorMessage(error))
      this.lastFailure = { ts: Date.now(), requestId, phase: "discord", message }
      this.eventLog.error("Discord operation failed", error, requestId)
      throw new Error(message)
    }
  }

  runSlackCommand(parsed: CliArguments, options: SlackCommandOptions = {}): Promise<unknown> {
    const context = {
      ...options,
      requestId: options.requestId ?? randomUUID(),
      signal: options.signal
        ? AbortSignal.any([options.signal, this.slackShutdown.signal])
        : this.slackShutdown.signal,
    }
    const startedAt = Date.now()
    const startedTick = performance.now()
    const operation = this.performSlackCommand(parsed, context)
    this.slackOperations.set(operation, {
      requestId: context.requestId,
      action: ["call", "upload-file", "download-file"].includes(parsed.words[1] ?? "")
        ? parsed.words[1]!
        : "invalid",
      startedAt,
      startedTick,
      signal: context.signal,
    })
    void operation.then(
      () => this.slackOperations.delete(operation),
      () => this.slackOperations.delete(operation),
    )
    return operation
  }

  private async performSlackCommand(
    parsed: CliArguments,
    options: SlackCommandOptions & { requestId: string; signal: AbortSignal },
  ): Promise<unknown> {
    const requestId = options.requestId
    const signal = options.signal
    validateSlackCommand(parsed)
    if (this.lifecycle !== "running") throw new Error("Runtime is not running")
    if (this.slackCredentials === null)
      throw new Error(
        "Slack is not configured; stop Leuco, copy each token, and run leuco slack login bot / leuco slack login app",
      )
    const startedTick = performance.now()
    this.eventLog.log(
      "info",
      `Slack operation started: ${parsed.words.slice(1).join(" ")}`,
      requestId,
    )
    try {
      signal.throwIfAborted()
      const reply = await executeSlackCommand({
        parsed,
        botToken: this.slackCredentials.botToken,
        upload: options.upload,
        signal,
      })
      await assertSlackReplyActive(reply, signal)
      return reply instanceof Response ? reply : this.eventLog.redactValue(reply)
    } catch (error) {
      const failure = signal.aborted
        ? new Error(
            "Slack operation cancelled; external effects may already have been accepted; inspect before replaying",
            { cause: error },
          )
        : error
      const safeFailure = this.eventLog.redactError(failure)
      const message = safeFailure.message
      this.lastFailure = { ts: Date.now(), requestId, phase: "slack", message }
      this.eventLog.error(
        `Slack operation failed after ${Math.max(0, Math.round(performance.now() - startedTick))} ms: ${message}`,
        safeFailure,
        requestId,
      )
      throw new Error(message, { cause: safeFailure })
    } finally {
      this.eventLog.log(
        "info",
        `Slack operation finished after ${Math.max(0, Math.round(performance.now() - startedTick))} ms`,
        requestId,
      )
    }
  }

  runTextTurn(
    key: string,
    text: string,
    requestId: string = randomUUID(),
  ): Promise<string | Error> {
    if (text.trim().length === 0)
      return Promise.resolve(new Error("Turn input must contain non-whitespace text"))
    if (!key || key.length > MAX_THREAD_KEY_CHARACTERS)
      return Promise.resolve(
        new Error(`Thread key must contain 1-${MAX_THREAD_KEY_CHARACTERS} UTF-16 code units`),
      )
    const bytes = Buffer.byteLength(text, "utf8")
    const rejected =
      this.lifecycle !== "running"
        ? "runtime_stopped"
        : bytes > MAX_TURN_INPUT_BYTES
          ? "input_bytes_limit"
          : this.pending.length >= 64
            ? "queue_count_limit"
            : this.pendingBytes + bytes > MAX_TURN_INPUT_BYTES
              ? "queue_bytes_limit"
              : null
    if (rejected !== null) {
      this.eventLog.append({
        ts: Date.now(),
        type: "turn.rejected",
        threadKey: key,
        requestId,
        reason: rejected,
        queueDepth: this.pending.length,
        queueBytes: this.pendingBytes,
        inputBytes: bytes,
        maxQueueDepth: 64,
        maxQueueBytes: MAX_TURN_INPUT_BYTES,
      })
      return Promise.resolve(
        new Error(
          rejected === "runtime_stopped"
            ? "Runtime is not running"
            : rejected === "input_bytes_limit"
              ? `Turn input exceeds ${MAX_TURN_INPUT_BYTES} UTF-8 bytes; reduce the input`
              : "Turn queue is full; retry after the current work finishes",
        ),
      )
    }
    return new Promise((resolveReply) => {
      this.pending.push({
        key,
        text,
        bytes,
        requestId,
        enqueuedAt: Date.now(),
        enqueuedTick: performance.now(),
        resolve: resolveReply,
      })
      this.pendingBytes += bytes
      this.eventLog.append({
        ts: Date.now(),
        type: "turn.queued",
        threadKey: key,
        requestId,
        queueDepth: this.pending.length,
        queueBytes: this.pendingBytes,
      })
      this.drain()
    })
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping
    // Diagnostic callbacks may synchronously request stop again.
    const stopped = Promise.withResolvers<void>()
    this.stopping = stopped.promise
    this.lifecycle = "stopping"
    this.slackShutdown.abort(new Error("Runtime stopped during Slack operation"))
    this.shutdown.resolve(new Error("Runtime stopped"))
    this.generation += 1
    for (const turn of this.pending.splice(0)) {
      this.eventLog.append({
        ts: Date.now(),
        type: "turn.error",
        requestId: turn.requestId,
        threadKey: turn.key,
        error: "Runtime stopped before execution",
        cancelled: true,
      })
      turn.resolve(new Error("Runtime stopped"))
    }
    this.pendingBytes = 0
    stopped.resolve(this.close())
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
      {
        name: "Slack operations",
        close: async () => {
          await awaitBoundedCleanup(
            Promise.allSettled(this.slackOperations.keys()),
            "Slack operations shutdown",
            1500,
          )
        },
      },
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
          message: this.eventLog.redactError(failure).message,
        }
      }
    }
    this.slackCredentials = null
    this.discordCredentials = null
    this.connections.splice(0)
    await this.logConsumer.close()
    this.lifecycle = "stopped"
    this.eventLog.append({ ts: Date.now(), type: "runtime.stopped" })
    try {
      if (this.ownsEventLog) this.eventLog.close()
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
    // Reserve the serial queue before execution can invoke diagnostic callbacks.
    const execution = Promise.withResolvers<string | Error>()
    this.active = execution.promise
      .then(turn.resolve, (error: unknown) => {
        this.eventLog.error("Unexpected turn lifecycle failure", error, turn.requestId)
        turn.resolve(error instanceof Error ? error : new Error(errorMessage(error)))
      })
      .finally(() => {
        this.active = null
        this.drain()
      })
    execution.resolve(this.execute(turn))
  }

  private async execute(turn: PendingTurn): Promise<string | Error> {
    const timeouts = new LeucoTurnTimeouts({
      hardTimeoutMs: this.settings.turnTimeoutMs,
      idleTimeoutMs: this.settings.idleTimeoutMs,
      clock: { setTimeout, clearTimeout },
    })
    const startedAt = Date.now()
    const startedTick = performance.now()
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
      queueWaitMs: Math.max(0, Math.round(startedTick - turn.enqueuedTick)),
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
        const failure = this.eventLog.redactError(reply)
        this.generation += 1
        if (this.lifecycle === "running")
          this.lastFailure = {
            ts: Date.now(),
            requestId: turn.requestId,
            phase: "turn",
            message: failure.message,
          }
        this.eventLog.append({
          ts: Date.now(),
          type: "turn.error",
          cancelled: this.lifecycle !== "running",
          requestId: turn.requestId,
          durationMs: Math.max(0, Math.round(performance.now() - startedTick)),
          threadKey: turn.key,
          error: failure.message,
          causes: errorDetails(failure),
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
          threadKey: turn.key,
          reply,
          durationMs: Math.max(0, Math.round(performance.now() - startedTick)),
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
    const isCurrent = () => generation === this.generation && this.lifecycle === "running"
    if (!isCurrent()) return new Error("Runtime stopped or turn cancelled")
    if (!this.codex.isRunning()) {
      this.eventLog.log(
        "info",
        "Reconnecting Codex for the next request; previous work is not replayed",
        turn.requestId,
      )
      if (!isCurrent()) return new Error("Runtime stopped or turn cancelled")
      await this.codex.start()
      if (!isCurrent()) return new Error("Runtime stopped or turn cancelled")
      this.conversations.clearLiveThreads()
      if (this.activeRequest?.requestId === turn.requestId) {
        this.activeRequest.lastActivity = "reading Codex instructions after reconnect"
        this.activeRequest.lastActivityAt = Date.now()
      }
      await this.conversations.refreshNativeInstructions(isCurrent)
    }
    if (!isCurrent()) return new Error("Runtime stopped or turn cancelled")
    const threadId = await this.conversations.ensure(turn.key, {
      requestId: turn.requestId,
      isCurrent,
      activity: (phase) => {
        if (this.activeRequest?.requestId === turn.requestId) {
          this.activeRequest.lastActivity = phase
          this.activeRequest.lastActivityAt = Date.now()
        }
      },
    })
    if (threadId instanceof Error) return threadId
    if (!isCurrent()) return new Error("Runtime stopped or turn cancelled")
    timeouts.startIdle()
    const activeRequest = this.activeRequest
    if (activeRequest !== null) activeRequest.lastActivity = "executing Codex turn"
    return this.codex.runTextTurn(threadId, turn.text, {
      cwd: this.cwd,
      requestId: turn.requestId,
      onActivity: (method) => {
        if (!isCurrent() || activeRequest === null || this.activeRequest !== activeRequest) return
        timeouts.activity()
        activeRequest.lastActivityAt = Date.now()
        activeRequest.lastActivity = method
      },
    })
  }

  private log(
    line: string,
    level: LogLevel = "info",
    requestId: string | null = this.activeRequest?.requestId ?? null,
  ): void {
    const safe = this.eventLog.redactText(line)
    this.eventLog.log(level, safe, requestId ?? undefined)
    this.logConsumer.write(safe, level, requestId)
  }
}
