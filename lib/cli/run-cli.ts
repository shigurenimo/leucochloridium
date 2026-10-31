import { isVersionRequest } from "@/cli/is-version-request"
import { withDaemonReservation } from "@/daemon/with-daemon-reservation"
import { readCliEvents } from "@/cli/read-cli-events"
import { readDaemonLogLines } from "@/daemon/read-daemon-log-lines"
import { assertRecordedDaemonsStopped } from "@/maintenance/assert-recorded-daemons-stopped"
import { launchOverrides } from "@/cli/launch-overrides"
import { repairRuntime } from "@/maintenance/repair-runtime"
import { scheduleRestart } from "@/maintenance/schedule-restart"
import { readMaintenance } from "@/maintenance/read-maintenance"
import { diagnoseRuntime } from "@/cli/diagnose-runtime"
import { randomUUID } from "node:crypto"
import { leucoHomeSchema } from "@/config/leuco-home-schema"
import { z } from "zod"
import pkg from "../../package.json" with { type: "json" }
import { validateCommand } from "@/cli/validate-command"
import { renderCliHelp } from "@/cli/render-cli-help"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { writeCliOutput } from "@/cli/write-cli-output"
import { writeCliText } from "@/cli/write-cli-text"
import { CliError } from "@/cli/cli-error"
import { COMMANDS, DEFAULT_CLI_LIMIT, DEFAULT_CLI_TIMEOUT_MS } from "@/cli/command-catalog"
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
import { runForegroundCommand } from "@/cli/run-foreground-command"
import { stopDaemon } from "@/daemon/stop-daemon"
import { startDaemon } from "@/daemon/start-daemon"
import { readDaemonLease, isProcessAlive } from "@/daemon/daemon-lease"
import { requestDaemon } from "@/daemon/request-daemon"

export async function runCli(
  args: string[],
  context: { signal?: AbortSignal; requestId?: string } = {},
): Promise<void> {
  const signal = context.signal
  signal?.throwIfAborted()
  const requestId = context.requestId ?? randomUUID()
  const json = jsonMode(args)
  if (isVersionRequest(args)) {
    if (json || args.includes("--yaml"))
      await writeCliOutput(
        { version: pkg.version },
        { json, command: "version", requestId, signal },
      )
    else await writeCliText(`${pkg.version}\n`, { destination: "stdout" })
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
    await writeCliText(`${help}\n`, { destination: "stdout" })
    return
  }
  validateCommand(parsed)
  if (!Bun.semver.satisfies(Bun.version, pkg.engines.bun))
    throw new CliError(
      "CHECK_FAILED",
      `Bun ${pkg.engines.bun} is required; found ${Bun.version}. Upgrade Bun before running Leuco operations.`,
      {
        phase: "runtime-version",
        executionStarted: false,
        current: Bun.version,
        required: pkg.engines.bun,
      },
    )
  const canonical = resolveCommand(parsed.words).definition.name
  const print = (value: unknown): Promise<void> =>
    writeCliOutput(value, { json, command: canonical, requestId, signal })
  const configuredHome = leucoHomeSchema.safeParse(process.env.LEUCO_HOME)
  if (!configuredHome.success)
    throw new CliError(
      "USAGE",
      "LEUCO_HOME must not be empty; unset it for ~/.leuco or provide a directory",
    )
  const home = configuredHome.data
  const store = new NodeLeucoStore(home)
  const command = parsed.words[0]
  if (command === "run") {
    await print(await runForegroundCommand({ home, parsed, requestId, signal }))
    return
  }
  if (command === "start") {
    await print(await startDaemon(home, parsed, signal))
    return
  }
  if (command === "restart") {
    const lease = readDaemonLease(home)
    const overrides = launchOverrides(parsed)
    await print(
      lease !== null && isProcessAlive(lease.pid)
        ? await requestDaemon({
            home,
            path: "/restart",
            body: overrides,
            requestId,
            signal,
            expectedLease: lease,
          })
        : scheduleRestart(home, overrides, { requestId, expectedLease: lease }),
    )
    return
  }
  if (command === "repair") {
    await print(
      await repairRuntime(home, { resetState: parsed.flags["reset-state"] === true, signal }),
    )
    return
  }
  if (command === "status") {
    const lease = readDaemonLease(home)
    if (lease === null || !isProcessAlive(lease.pid)) {
      const maintenance = readMaintenance(home)
      if (maintenance !== null && "oldPid" in maintenance)
        assertRecordedDaemonsStopped(maintenance, isProcessAlive)
      await print({ running: false, maintenance })
      return
    }
    await print(
      await requestDaemon({ home, path: "/status", requestId, signal, expectedLease: lease }),
    )
    return
  }
  if (command === "stop") {
    await print(await stopDaemon({ home, requestId, signal }))
    return
  }
  if (command === "ask") {
    const text = parsed.words.slice(1).join(" ")
    const response = z.object({ reply: z.string() }).parse(
      await requestDaemon({
        home,
        path: "/turn",
        body: { text, key: parsed.flags.thread ?? "cli" },
        requestId,
        timeoutMs: Number(parsed.flags["timeout-ms"] ?? DEFAULT_CLI_TIMEOUT_MS),
        signal,
      }),
    )
    await print({ reply: response.reply })
    return
  }
  if (command === "config" || command === "schedules") {
    await print(await manageSettings(parsed, store))
    return
  }
  if (command === "slack") {
    const action = parsed.words[1]
    if (action === "login" || action === "logout") {
      const lease = readDaemonLease(home)
      if (lease !== null && isProcessAlive(lease.pid))
        throw new CliError("STATE_CONFLICT", "Stop Leuco before changing Slack credentials")
      store.ensureHome()
      const credentialStatus = await withDaemonReservation(home, () => {
        const services = {
          store,
          credentials: new BunCredentialStore(),
          signal,
        }
        return action === "login"
          ? manageSlackCredentials({
              ...services,
              action: "login",
              clipboard: new NodeClipboard(),
              kind: z.enum(["bot", "app"]).parse(parsed.words[2]),
            })
          : manageSlackCredentials({ ...services, action: "logout" })
      })
      await print(credentialStatus)
      return
    }
    await print(await requestSlackCommand(home, parsed, { signal, requestId }))
    return
  }
  if (command === "session") {
    const action = parsed.words[1]
    if (action === "list") {
      await print(store.loadState().threads)
      return
    }
    const lease = readDaemonLease(home)
    if (lease !== null && isProcessAlive(lease.pid))
      throw new CliError("STATE_CONFLICT", "Stop Leuco before resetting conversation mappings")
    store.ensureHome()
    await withDaemonReservation(home, () =>
      store.updateState((state) => ({
        ...state,
        threads: Object.fromEntries(
          Object.entries(state.threads).filter(
            ([key]) => parsed.words[2] !== undefined && key !== parsed.words[2],
          ),
        ),
      })),
    )
    await print({ reset: parsed.words[2] ?? "all" })
    return
  }
  if (command === "logs") {
    await print({
      lines: readDaemonLogLines(home, Number(parsed.flags.limit ?? DEFAULT_CLI_LIMIT)),
    })
    return
  }
  if (command === "events") {
    await print(
      await readCliEvents({
        home,
        limit: Number(parsed.flags.limit ?? DEFAULT_CLI_LIMIT),
        requestId,
        signal,
        filters: {
          summary: parsed.flags.summary === true,
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
    await print(report)
    return
  }

  throw new Error(`Unknown command: ${command}. Run leuco --help`)
}
