import { readCliEvents } from "@/cli/read-cli-events"
import { readRegularText } from "@/fs/read-regular-text"
import { redactPublicText } from "@/secrets/redact-public-text"
import { launchOverrides } from "@/cli/launch-overrides"
import { repairRuntime } from "@/maintenance/repair-runtime"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { readMaintenance } from "@/maintenance/read-maintenance"
import { diagnoseRuntime } from "@/cli/diagnose-runtime"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import pkg from "../../package.json" with { type: "json" }
import { validateCommand } from "@/cli/validate-command"
import { renderCliHelp } from "@/cli/render-cli-help"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { writeCliOutput } from "@/cli/write-cli-output"
import { CliError } from "@/cli/cli-error"
import { COMMANDS } from "@/cli/command-catalog"
import { resolveCommand } from "@/cli/resolve-command"
import { serializeCliValue } from "@/cli/serialize-cli-value"
import { jsonMode } from "@/cli/json-mode"
import { parseArguments } from "@/cli/parse-arguments"
import { manageSettings } from "@/cli/manage-settings"
import { requestSlackCommand } from "@/cli/request-slack-command"
import { manageSlackCredentials } from "@/cli/manage-slack-credentials"
import { NodeClipboard } from "@/clipboard/node-clipboard"
import { BunCredentialStore } from "@/secrets/bun-credential-store"
import { NodeLeucoStore } from "@/storage/node-leuco-store"
import { runDaemon } from "@/daemon/run-daemon"
import { startDaemon } from "@/daemon/start-daemon"
import {
  readDaemonLease,
  isProcessAlive,
  acquireDaemonLease,
  releaseDaemonLease,
} from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"
import type { LeucoRuntimeProps } from "@/runtime/runtime"

export async function runCli(
  args: string[],
  context: { signal?: AbortSignal; requestId?: string } = {},
): Promise<void> {
  const signal = context.signal
  const requestId = context.requestId ?? randomUUID()
  const json = jsonMode(args)
  if (
    args.some((arg) => arg === "--version" || arg === "-v") &&
    args.every((arg) => ["--version", "-v", "--json", "--yaml"].includes(arg))
  ) {
    if (json || args.includes("--yaml"))
      writeCliOutput({ version: pkg.version }, { json, command: "version", requestId, signal })
    else process.stdout.write(`${pkg.version}\n`)
    return
  }
  const parsed = parseArguments(args)
  if (parsed.flags.help || args.length === 0) {
    const helpPath =
      parsed.words.length === 0 ||
      COMMANDS.some((entry) => entry.name.startsWith(`${parsed.words.join(" ")} `))
        ? parsed.words
        : resolveCommand(parsed.words).definition.name.split(" ")
    const help =
      json || parsed.flags.yaml
        ? serializeCliValue(getCliSpecification(helpPath), json)
        : renderCliHelp(parsed.words)
    process.stdout.write(`${help}\n`)
    return
  }
  validateCommand(parsed)
  const canonical = resolveCommand(parsed.words).definition.name
  const print = (value: unknown): void =>
    writeCliOutput(value, { json, command: canonical, requestId, signal })
  const home = resolve(process.env.LEUCO_HOME ?? join(homedir(), ".leuco"))
  const store = new NodeLeucoStore(home)
  const command = parsed.words[0]
  if (command === "run") {
    const options: LeucoRuntimeProps & { prompt?: string; thread?: string } = { home }
    Object.assign(options, launchOverrides(parsed))
    if (typeof parsed.flags.prompt === "string") options.prompt = parsed.flags.prompt
    if (typeof parsed.flags.thread === "string") options.thread = parsed.flags.thread
    const captured: { reply: string | null } = { reply: null }
    await runDaemon({
      ...options,
      home,
      quiet: !parsed.flags.foreground,
      ownsProcess: true,
      requestId,
      signal,
      onReply: (reply) => {
        captured.reply = reply
      },
    })
    if (options.prompt !== undefined)
      print({ reply: captured.reply, cancelled: captured.reply === null })
    else print({ stopped: true })
    return
  }
  if (command === "start") {
    store.ensureHome()
    if (parsed.flags.prompt) throw new Error("Use leuco run --prompt for one-shot execution")
    print(await startDaemon(home, args.slice(1)))
    return
  }
  if (command === "restart") {
    const lease = readDaemonLease(home)
    const overrides = launchOverrides(parsed)
    print(
      lease !== null && isProcessAlive(lease.pid)
        ? await requestDaemon({
            home,
            path: "/restart",
            body: overrides,
            requestId,
            signal,
            expectedLease: lease,
          })
        : scheduleRestart(home, overrides, { requestId }),
    )
    return
  }
  if (command === "repair") {
    print(await repairRuntime(home, { resetState: parsed.flags["reset-state"] === true, signal }))
    return
  }
  if (command === "status") {
    const lease = readDaemonLease(home)
    if (lease === null || !isProcessAlive(lease.pid)) {
      print({ running: false, maintenance: readMaintenance(home) })
      return
    }
    print(await requestDaemon({ home, path: "/status", requestId, signal }))
    return
  }
  if (command === "stop") {
    const lease = readDaemonLease(home)
    if (lease === null || !isProcessAlive(lease.pid)) {
      print({ running: false })
      return
    }
    const stopped = z.object({ stopped: z.boolean(), processWillExit: z.boolean() }).parse(
      await requestDaemon({
        home,
        path: "/stop",
        body: {},
        requestId,
        signal,
        expectedLease: lease,
      }),
    )
    if (!stopped.stopped)
      throw new CliError(
        "STATE_UNCERTAIN",
        "Shutdown was requested but resource closure was not confirmed; inspect status and events",
      )
    if (stopped.processWillExit) {
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && isProcessAlive(lease.pid)) await Bun.sleep(100)
      if (isProcessAlive(lease.pid))
        throw new CliError(
          "STATE_UNCERTAIN",
          "Leuco resources stopped but its process has not exited; inspect logs",
        )
    }
    print({ stopped: true })
    return
  }
  if (command === "ask") {
    const text = parsed.words.slice(1).join(" ")
    if (!text) throw new Error("Usage: leuco ask <text> [--thread <key>]")
    const response = z.object({ reply: z.string() }).parse(
      await requestDaemon({
        home,
        path: "/turn",
        body: { text, key: parsed.flags.thread ?? "cli" },
        requestId,
        timeoutMs: Number(parsed.flags["timeout-ms"] ?? 30000),
        signal,
      }),
    )
    print({ reply: response.reply })
    return
  }
  if (command === "config" || command === "schedules") {
    print(await manageSettings(parsed, store))
    return
  }
  if (command === "slack") {
    const action = parsed.words[1]
    if (action === "login" || action === "logout") {
      const lease = readDaemonLease(home)
      if (lease !== null && isProcessAlive(lease.pid))
        throw new CliError("STATE_CONFLICT", "Stop Leuco before changing Slack credentials")
      store.ensureHome()
      const reservation = acquireDaemonLease(home)
      try {
        const services = {
          store,
          credentials: new BunCredentialStore(),
          clipboard: new NodeClipboard(),
          signal,
        }
        print(
          await (action === "login"
            ? manageSlackCredentials({
                ...services,
                action: "login",
                kind: z.enum(["bot", "app"]).parse(parsed.words[2]),
              })
            : manageSlackCredentials({ ...services, action: "logout" })),
        )
      } finally {
        releaseDaemonLease(home, reservation)
      }
      return
    }
    print(await requestSlackCommand(home, parsed, { signal, requestId }))
    return
  }
  if (command === "session") {
    const action = parsed.words[1] ?? "list"
    if (action === "list") {
      print(store.loadState().threads)
      return
    }
    if (action !== "reset") throw new Error("Usage: leuco session list | reset [key]")
    store.ensureHome()
    const reservation = acquireDaemonLease(home)
    try {
      store.updateState((state) => ({
        ...state,
        threads: Object.fromEntries(
          Object.entries(state.threads).filter(
            ([key]) => parsed.words[2] !== undefined && key !== parsed.words[2],
          ),
        ),
      }))
    } finally {
      releaseDaemonLease(home, reservation)
    }
    print({ reset: parsed.words[2] ?? "all" })
    return
  }
  if (command === "logs") {
    const path = join(home, "daemon.log")
    const content = existsSync(path) ? redactPublicText(readRegularText(path)).trimEnd() : ""
    const lines = content ? content.split("\n").slice(-limit(parsed.flags.limit)) : []
    print({ lines })
    return
  }
  if (command === "events") {
    print(
      await readCliEvents({
        home,
        limit: limit(parsed.flags.limit),
        requestId,
        signal,
        filters: {
          requestId: typeof parsed.flags.request === "string" ? parsed.flags.request : undefined,
          type: typeof parsed.flags.type === "string" ? parsed.flags.type : undefined,
          since: typeof parsed.flags.since === "string" ? Number(parsed.flags.since) : undefined,
        },
      }),
    )
    return
  }
  if (command === "doctor") {
    const report = await diagnoseRuntime(home, signal)
    if (!report.healthy)
      throw new CliError("CHECK_FAILED", "Environment or daemon checks failed", report)
    print(report)
    return
  }

  throw new Error(`Unknown command: ${command}. Run leuco --help`)
}

function limit(value: string | true | undefined): number {
  if (value === undefined) return 100
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000)
    throw new Error("--limit must be between 1 and 10000")
  return parsed
}
