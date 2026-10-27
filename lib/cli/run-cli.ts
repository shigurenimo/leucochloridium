import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import pkg from "../../package.json" with { type: "json" }
import { validateCommand } from "@/cli/validate-command"
import { HELP } from "@/cli/help"
import { parseArguments } from "@/cli/parse-arguments"
import { manageSettings } from "@/cli/manage-settings"
import { requestSlackCommand } from "@/cli/request-slack-command"
import { manageSlackCredentials } from "@/cli/manage-slack-credentials"
import { NodeSecretPrompt } from "@/cli/node-secret-prompt"
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
import { LeucoEventLog } from "@/events/leuco-event-log"
import type { LeucoRuntimeProps } from "@/runtime/runtime"

export async function runCli(args: string[]): Promise<void> {
  if (args[0] === "--version" || args[0] === "-v") {
    print(pkg.version)
    return
  }
  const parsed = parseArguments(args)
  if (parsed.flags.help || args.length === 0) {
    print(HELP)
    return
  }
  validateCommand(parsed)
  const home = resolve(process.env.LEUCO_HOME ?? join(homedir(), ".leuco"))
  const store = new NodeLeucoStore(home)
  store.ensureHome()
  const command = parsed.words[0]
  if (command === "run") {
    const options: LeucoRuntimeProps & { prompt?: string; thread?: string } = { home }
    if (typeof parsed.flags.cwd === "string") options.cwd = resolve(parsed.flags.cwd)
    if (typeof parsed.flags.soul === "string") options.soul = resolve(parsed.flags.soul)
    if (parsed.flags["no-soul"]) options.soul = null
    if (typeof parsed.flags.model === "string") options.model = parsed.flags.model
    if (typeof parsed.flags["codex-bin"] === "string")
      options.codexBin = resolve(parsed.flags["codex-bin"])
    if (typeof parsed.flags.prompt === "string") options.prompt = parsed.flags.prompt
    if (typeof parsed.flags.thread === "string") options.thread = parsed.flags.thread
    await runDaemon({ ...options, home })
    return
  }
  if (command === "start") {
    if (parsed.flags.prompt) throw new Error("Use leuco run --prompt for one-shot execution")
    print(await startDaemon(home, args.slice(1)))
    return
  }
  if (command === "status") {
    const lease = readDaemonLease(home)
    if (lease === null || !isProcessAlive(lease.pid)) {
      print({ running: false })
      return
    }
    print(await requestDaemon(home, "/status"))
    return
  }
  if (command === "stop") {
    const lease = readDaemonLease(home)
    if (lease === null || !isProcessAlive(lease.pid)) {
      print({ running: false })
      return
    }
    await requestDaemon(home, "/stop", {})
    const deadline = Date.now() + 15_000
    while (
      Date.now() < deadline &&
      readDaemonLease(home)?.token === lease.token &&
      isProcessAlive(lease.pid)
    )
      await Bun.sleep(100)
    if (readDaemonLease(home)?.token === lease.token && isProcessAlive(lease.pid))
      throw new Error("Leuco is still stopping; inspect status and logs")
    print({ stopped: true })
    return
  }
  if (command === "ask") {
    const text = parsed.words.slice(1).join(" ")
    if (!text) throw new Error("Usage: leuco ask <text> [--thread <key>]")
    const response = z
      .object({ reply: z.string() })
      .parse(await requestDaemon(home, "/turn", { text, key: parsed.flags.thread ?? "cli" }, null))
    print(response.reply)
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
        throw new Error("Stop Leuco before changing Slack credentials")
      const reservation = acquireDaemonLease(home)
      try {
        print(
          await manageSlackCredentials({
            action,
            store,
            credentials: new BunCredentialStore(),
            prompt: new NodeSecretPrompt(),
          }),
        )
      } finally {
        releaseDaemonLease(home, reservation)
      }
      return
    }
    print(await requestSlackCommand(home, parsed))
    return
  }
  if (command === "session") {
    const action = parsed.words[1] ?? "list"
    if (action === "list") {
      print(store.loadState().threads)
      return
    }
    if (action !== "reset") throw new Error("Usage: leuco session list | reset [key]")
    const lease = readDaemonLease(home)
    if (lease !== null && isProcessAlive(lease.pid))
      throw new Error("Stop Leuco before resetting conversation mappings")
    store.updateState((state) => ({
      ...state,
      threads: Object.fromEntries(
        Object.entries(state.threads).filter(
          ([key]) => parsed.words[2] !== undefined && key !== parsed.words[2],
        ),
      ),
    }))
    print({ reset: parsed.words[2] ?? "all" })
    return
  }
  if (command === "logs") {
    const path = join(home, "daemon.log")
    if (existsSync(path))
      print(
        readFileSync(path, "utf8")
          .trimEnd()
          .split("\n")
          .slice(-limit(parsed.flags.limit))
          .join("\n"),
      )
    return
  }
  if (command === "events") {
    const path = join(home, "events.db")
    if (!existsSync(path)) {
      print([])
      return
    }
    const log = new LeucoEventLog({ eventLogPath: path })
    try {
      print(log.query({ order: "desc", limit: limit(parsed.flags.limit) }))
    } finally {
      log.close()
    }
    return
  }
  if (command === "doctor") {
    const settings = store.loadSettings()
    const cwd = settings.cwd ?? process.cwd()
    const validCwd = existsSync(cwd) && statSync(cwd).isDirectory()
    const binary = Bun.which("codex")
    print({
      cwd,
      cwdExists: validCwd,
      codex: binary,
      codexHome: process.env.CODEX_HOME ?? join(homedir(), ".codex"),
      soulExists: settings.soul === null || existsSync(settings.soul),
      slackConfigured: settings.slack !== null,
    })
    if (!validCwd || binary === null || (settings.soul !== null && !existsSync(settings.soul)))
      process.exitCode = 1
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

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`)
}
