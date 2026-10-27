import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { settingsSchema } from "@/config/config-schema"
import type { LeucoSettings } from "@/config/config-schema"
import type { Connector } from "@/connectors/connector"
import { LeucoSlackConnector } from "@/connectors/slack/slack-connector"
import { LeucoFlumeSlackEventSource } from "@/connectors/slack/leuco-flume-slack-event-source"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { LeucoScheduleConnector } from "@/connectors/schedule/schedule-connector"
import { LeucoCodexClient } from "@/engine/codex/codex-client"
import type { CodexClientPort } from "@/engine/codex/codex-client-port"
import { LeucoTurnTimeouts } from "@/engine/turn-timeouts"
import { isCodexHistoryCorruptionError } from "@/engine/codex/is-codex-history-corruption-error"
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
  key: string
  text: string
  bytes: number
  resolve: (reply: string | Error) => void
}

export class LeucoRuntime {
  readonly cwd: string
  readonly home: string
  private readonly store: LeucoStore
  private readonly settings: LeucoSettings
  private readonly codex: CodexClientPort
  private readonly eventLog: LeucoEventLog
  private readonly connections: Connector[]
  private readonly liveThreads = new Set<string>()
  private readonly pending: PendingTurn[] = []
  private readonly contextHome: string
  private slackCredentials: SlackCredentials | null = null
  private instructions = ""
  private context = ""
  private active: Promise<void> | null = null
  private pendingBytes = 0
  private lifecycle: "new" | "starting" | "running" | "stopping" | "stopped" = "new"
  private stopping: Promise<void> | null = null
  private generation = 0

  private constructor(private readonly props: LeucoRuntimeProps) {
    const env = props.env ?? process.env
    this.home = resolve(props.home ?? env.LEUCO_HOME ?? join(homedir(), ".leuco"))
    this.store = props.store ?? new NodeLeucoStore(this.home)
    this.settings = settingsSchema.parse(this.store.loadSettings())
    this.cwd = resolve(props.cwd ?? this.settings.cwd ?? process.cwd())
    this.contextHome = env.CODEX_HOME ?? join(homedir(), ".codex")
    this.eventLog = props.eventLog ?? new LeucoEventLog()
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
              runtime: "leuco",
              ...bounded,
            })
        },
      })
    this.connections = [...(props.connections ?? [])]
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
      if (this.props.connections === undefined) this.connections.push(...this.buildConnections())
      await this.codex.start()
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      await this.loadInstructions()
      if (this.lifecycle !== "starting") throw new Error("Runtime stopped during startup")
      this.lifecycle = "running"
      for (const connection of this.connections) {
        if (this.lifecycle !== "running") throw new Error("Runtime stopped during startup")
        await connection.start({
          cwd: this.cwd,
          runtimeName: "leuco",
          eventLog: this.eventLog,
          onLog: (line) => this.log(line),
          runTextTurn: (key, text) => this.runTextTurn(key, text),
        })
        if (this.lifecycle !== "running") {
          await connection.stop()
          throw new Error("Runtime stopped during startup")
        }
      }
      this.eventLog.append({ ts: Date.now(), type: "runtime.started", runtime: "leuco" })
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async runSlackCommand(parsed: CliArguments, upload?: Uint8Array): Promise<unknown> {
    validateCommand(parsed)
    if (
      parsed.words[0] !== "slack" ||
      !["call", "upload-file", "download-file"].includes(parsed.words[1] ?? "")
    )
      throw new Error("Unsupported Slack operation")
    if (this.lifecycle !== "running") throw new Error("Runtime is not running")
    if (this.slackCredentials === null)
      throw new Error("Slack is not configured; stop Leuco and run leuco slack login")
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
  }

  runTextTurn(key: string, text: string): Promise<string | Error> {
    if (this.lifecycle !== "running") return Promise.resolve(new Error("Runtime is not running"))
    const bytes = Buffer.byteLength(text, "utf8")
    if (!key || key.length > 512)
      return Promise.resolve(new Error("Thread key must contain 1-512 characters"))
    if (this.pending.length >= 64 || this.pendingBytes + bytes > 256 * 1024) {
      return Promise.resolve(new Error("Turn queue is full; retry after the current work finishes"))
    }
    return new Promise((resolveReply) => {
      this.pending.push({ key, text, bytes, resolve: resolveReply })
      this.pendingBytes += bytes
      this.drain()
    })
  }

  stop(): Promise<void> {
    if (this.stopping !== null) return this.stopping
    this.lifecycle = "stopping"
    this.generation += 1
    for (const turn of this.pending.splice(0)) turn.resolve(new Error("Runtime stopped"))
    this.pendingBytes = 0
    this.stopping = this.close()
    return this.stopping
  }

  private async close(): Promise<void> {
    try {
      try {
        await this.codex.stop()
      } finally {
        await Promise.allSettled(this.connections.map((connection) => connection.stop()))
        if (this.active !== null) await this.active
      }
    } finally {
      this.slackCredentials = null
      this.connections.splice(0)
      this.lifecycle = "stopped"
      this.eventLog.append({ ts: Date.now(), type: "runtime.stopped", runtime: "leuco" })
      this.eventLog.close()
    }
  }

  private drain(): void {
    if (this.active !== null || this.lifecycle !== "running") return
    const turn = this.pending.shift()
    if (turn === undefined) return
    this.pendingBytes -= turn.bytes
    this.active = this.execute(turn)
      .then(turn.resolve, (error: unknown) => turn.resolve(new Error(errorMessage(error))))
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
    this.eventLog.append({
      ts: startedAt,
      type: "turn.start",
      runtime: "leuco",
      threadKey: turn.key,
      input: turn.text,
    })
    try {
      const reply = await Promise.race([
        this.runCodex(turn, timeouts, this.generation),
        timeouts.hardTimeout,
        timeouts.idleTimeout,
      ]).catch((error: unknown) => new Error(errorMessage(error)))
      if (reply instanceof Error) {
        this.generation += 1
        this.eventLog.append({
          ts: Date.now(),
          type: "turn.error",
          runtime: "leuco",
          threadKey: turn.key,
          error: reply.message,
        })
        await this.codex.stop()
        this.liveThreads.clear()
      } else {
        this.eventLog.append({
          ts: Date.now(),
          type: "turn.complete",
          runtime: "leuco",
          threadKey: turn.key,
          reply,
          durationMs: Date.now() - startedAt,
        })
      }
      return reply
    } finally {
      timeouts.clear()
    }
  }

  private async runCodex(
    turn: PendingTurn,
    timeouts: LeucoTurnTimeouts,
    generation: number,
  ): Promise<string | Error> {
    if (!this.codex.isRunning()) {
      await this.codex.start()
      this.liveThreads.clear()
      if (this.lifecycle !== "running") return new Error("Runtime stopped")
    }
    if (generation !== this.generation) return new Error("Turn was cancelled")
    const threadId = await this.ensureThread(turn.key, generation)
    if (threadId instanceof Error) return threadId
    if (this.lifecycle !== "running" || generation !== this.generation)
      return new Error("Runtime stopped or turn cancelled")
    timeouts.startIdle()
    return this.codex.runTextTurn(threadId, turn.text, {
      cwd: this.cwd,
      onActivity: () => timeouts.activity(),
    })
  }

  private async ensureThread(key: string, generation: number): Promise<string | Error> {
    const saved = this.store.loadState().threads[key]
    if (saved?.context === this.context) {
      if (this.liveThreads.has(saved.id)) return saved.id
      const resumed = await this.codex.resumeThread({ threadId: saved.id, cwd: this.cwd })
      if (generation !== this.generation) return new Error("Turn was cancelled")
      if (resumed instanceof Error && !isCodexHistoryCorruptionError(resumed)) return resumed
      if (resumed !== null && !(resumed instanceof Error)) {
        this.liveThreads.add(resumed.thread.id)
        return resumed.thread.id
      }
    }
    const created = await this.codex.startThread({
      cwd: this.cwd,
      ...(this.instructions ? { developerInstructions: this.instructions } : {}),
      ...((this.props.model ?? this.settings.model)
        ? { model: this.props.model ?? this.settings.model ?? undefined }
        : {}),
    })
    if (created instanceof Error) return created
    if (generation !== this.generation) return new Error("Turn was cancelled")
    const id = created.thread.id
    this.store.updateState((state) => ({
      ...state,
      threads: { ...state.threads, [key]: { id, context: this.context } },
    }))
    this.liveThreads.add(id)
    return id
  }

  private async loadInstructions(): Promise<void> {
    const soul = this.props.soul === undefined ? this.settings.soul : this.props.soul
    const native = (await this.codex.getDeveloperInstructions?.()) ?? ""
    const extra = soul === null ? "" : this.store.readInstructions(resolve(this.cwd, soul))
    this.instructions = extra ? [native, extra].filter(Boolean).join("\n\n") : ""
    this.context = createHash("sha256")
      .update(
        JSON.stringify([
          this.contextHome,
          this.cwd,
          native,
          extra,
          this.props.model ?? this.settings.model,
        ]),
      )
      .digest("hex")
  }

  private buildConnections(): Connector[] {
    const connections: Connector[] = []
    const slack = this.settings.slack
    const credentials = this.slackCredentials
    if (slack !== null && credentials !== null)
      connections.push(
        new LeucoSlackConnector({
          name: "slack",
          usesUserToken: credentials.botToken.startsWith("xoxp-"),
          ackMode: slack.ackMode,
          webClient: new LeucoFetchSlackWebClient({ botToken: credentials.botToken }),
          eventSource: new LeucoFlumeSlackEventSource({
            botToken: credentials.botToken,
            appToken: credentials.appToken,
          }),
        }),
      )
    connections.push(
      new LeucoScheduleConnector({
        name: "schedule",
        store: {
          listEntries: () => this.store.loadSettings().schedules,
          removeEntry: (id) =>
            this.store.updateSettings((settings) => ({
              ...settings,
              schedules: settings.schedules.filter((entry) => entry.id !== id),
            })),
          getLastFiredAt: (id) => this.store.loadState().scheduleLastFiredAt[id] ?? null,
          markFired: (id, timestamp) =>
            this.store.updateState((state) => ({
              ...state,
              scheduleLastFiredAt: { ...state.scheduleLastFiredAt, [id]: timestamp },
            })),
        },
      }),
    )
    return connections
  }

  private log(line: string): void {
    const safe = this.eventLog.redactText(line)
    this.eventLog.log("info", safe)
    this.props.onLog?.(safe)
  }
}
