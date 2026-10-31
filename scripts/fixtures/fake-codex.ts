#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

const state = { threads: 0, turns: 0 }
if (process.env.LEUCO_VERIFY_STDERR === "1")
  process.on("SIGTERM", () => {
    process.stderr.write(
      '{"level":"WARN","fields":{"message":"final unterminated stderr marker"}}',
      () => process.exit(0),
    )
  })
const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
appendFileSync(
  process.env.LEUCO_VERIFY_TRACE!,
  `${JSON.stringify({ env: { CODEX_HOME: process.env.CODEX_HOME, LEUCO_HOME: process.env.LEUCO_HOME }, args: process.argv.slice(2) })}\n`,
)
if (process.env.LEUCO_VERIFY_ENV_GUARD === "1") {
  const names = Object.keys(process.env)
  appendFileSync(
    process.env.LEUCO_VERIFY_TRACE!,
    `${JSON.stringify({
      environmentGuard: {
        slackTokenKeys: names.filter((name) => /^(?:LEUCO_)?SLACK_(?:BOT|APP)_TOKEN$/i.test(name)),
        leucoHomeKeys: names.filter((name) => /^LEUCO_HOME$/i.test(name)),
        obsoleteProjectKeys: names.filter((name) => /^LEUCO_PROJECT_ID$/i.test(name)),
      },
    })}\n`,
  )
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  appendFileSync(process.env.LEUCO_VERIFY_TRACE!, `${JSON.stringify(request)}\n`)
  if (request.id === undefined) continue
  if (request.method === "initialize") {
    if (process.env.LEUCO_VERIFY_STDERR === "1") {
      process.stderr.write('{"level":"WA')
      await Bun.sleep(10)
      process.stderr.write('RN","fields":{"message":"xoxb-synthetic-')
      await Bun.sleep(10)
      process.stderr.write('cli-stderr-token"}}\n')
    }
    await Bun.sleep(Number(process.env.LEUCO_VERIFY_INIT_DELAY_MS ?? 0))
    send({ id: request.id, result: {} })
  } else if (request.method === "config/read")
    send({
      id: request.id,
      result: {
        config: {
          developer_instructions: process.env.LEUCO_VERIFY_NATIVE_INSTRUCTIONS_FILE
            ? readFileSync(process.env.LEUCO_VERIFY_NATIVE_INSTRUCTIONS_FILE, "utf8")
            : "native instruction",
        },
      },
    })
  else if (request.method === "thread/start")
    send({
      id: request.id,
      result: {
        thread: {
          id:
            process.env.LEUCO_VERIFY_START_THREAD_ID_FILE &&
            existsSync(process.env.LEUCO_VERIFY_START_THREAD_ID_FILE)
              ? readFileSync(process.env.LEUCO_VERIFY_START_THREAD_ID_FILE, "utf8")
              : `thread-${process.pid}-${++state.threads}`,
        },
      },
    })
  else if (
    request.method === "thread/resume" &&
    process.env.LEUCO_VERIFY_RESUME_ERROR_FILE &&
    existsSync(process.env.LEUCO_VERIFY_RESUME_ERROR_FILE)
  )
    send({
      id: request.id,
      error: {
        code:
          readFileSync(process.env.LEUCO_VERIFY_RESUME_ERROR_FILE, "utf8") === "internal-history"
            ? -32603
            : -32600,
        message: ["internal-history", "invalid-history"].includes(
          readFileSync(process.env.LEUCO_VERIFY_RESUME_ERROR_FILE, "utf8"),
        )
          ? "[ObjectParam] [input[7].arguments.bad] invalid_request_error: property is invalid"
          : readFileSync(process.env.LEUCO_VERIFY_RESUME_ERROR_FILE, "utf8") === "missing"
            ? `no rollout found for thread id ${request.params.threadId}`
            : "model not found: configured-model",
      },
    })
  else if (request.method === "thread/resume")
    send({
      id: request.id,
      result: {
        thread: {
          id: process.env.LEUCO_VERIFY_RESUME_THREAD_ID_FILE
            ? readFileSync(process.env.LEUCO_VERIFY_RESUME_THREAD_ID_FILE, "utf8")
            : request.params.threadId,
        },
      },
    })
  else if (request.method === "turn/start") {
    const threadId = request.params.threadId
    const turnId =
      process.env.LEUCO_VERIFY_TURN_ID_FILE && existsSync(process.env.LEUCO_VERIFY_TURN_ID_FILE)
        ? readFileSync(process.env.LEUCO_VERIFY_TURN_ID_FILE, "utf8")
        : `turn-${++state.turns}`
    if (process.env.LEUCO_VERIFY_TURN_STDERR === "1") {
      process.stderr.write("terminal-control-probe\u009b31m\u001b[2J xoxb-synthetic-tty-token\n")
      process.stderr.write(
        "socket-query-probe connection to 'wss://wss-primary.slack.com/link/?ticket=synthetic-socket-ticket&app_id=synthetic-app' failed: ECONNRESET\n",
      )
      process.stderr.write(
        "url-credential-probe 'wss://private-url-user:private-url-password@wss-primary.slack.com/link/?ticket=private-url-ticket' failed: ECONNRESET\n",
      )
      const prefix = "unicode-stderr-probe "
      process.stderr.write(`${prefix}${"x".repeat(11999 - prefix.length)}😀discarded\n`)
    }
    if (
      process.env.LEUCO_VERIFY_EARLY_NOTIFICATIONS_FILE &&
      existsSync(process.env.LEUCO_VERIFY_EARLY_NOTIFICATIONS_FILE)
    ) {
      const mode = readFileSync(process.env.LEUCO_VERIFY_EARLY_NOTIFICATIONS_FILE, "utf8")
      const count = mode === "count" ? 1001 : 3
      const delta = mode === "bytes" ? "x".repeat(600000) : "early"
      for (const _ of Array.from({ length: count }))
        send({
          method: "item/agentMessage/delta",
          params: { threadId, turnId, itemId: "early", delta },
        })
    }
    const correlationBarrier = process.env.LEUCO_VERIFY_NOTIFICATION_CORRELATION_FILE
    if (correlationBarrier) send({ method: "probe/unconfirmed", params: { threadId, turnId } })
    send({ id: request.id, result: { turn: { id: turnId } } })
    if (correlationBarrier) {
      const deadline = performance.now() + 2000
      while (!existsSync(correlationBarrier)) {
        if (performance.now() >= deadline) throw new Error("Turn acknowledgement was not observed")
        await Bun.sleep(1)
      }
      send({ method: "probe/current", params: { threadId, turnId } })
      send({ method: "probe/conflicting", params: { threadId, turnId, turn: { id: "old-turn" } } })
      send({ method: "probe/old-turn", params: { threadId, turnId: "old-turn" } })
      send({ method: "probe/other-thread", params: { threadId: "other-thread", turnId } })
      send({ method: "probe/background", params: {} })
    }
    if (process.env.LEUCO_VERIFY_NOTIFICATION_SECRET_BOUNDARY === "1") {
      const secret = JSON.parse(
        readFileSync(join(process.env.LEUCO_HOME!, "daemon.json"), "utf8"),
      ).token
      process.stderr.write(`${"s".repeat(11980)}${secret}${"q".repeat(100)}\n`)
      process.stdout.write(`protocol-raw ${"p".repeat(1948)} ${secret} ${"z".repeat(2000)}\n`)
      send({ unknown: `protocol-unknown ${"u".repeat(1948)}${secret}${"z".repeat(2000)}` })
      send({
        method: `probe/${"m".repeat(238)}${secret}`,
        params: { text: `${"x".repeat(7750)}${secret}${"y".repeat(30000)}` },
      })
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "mcpToolCall",
            id: "redaction-probe",
            tool: `${"t".repeat(240)}${secret}`,
            durationMs: null,
            result: { text: "null-duration-large-result".repeat(2000) },
          },
        },
      })
    }

    if (request.params.input?.some((entry: { text?: string }) => entry.text === "hold")) continue
    if (
      request.params.input?.some((entry: { text?: string }) => entry.text === "oversized-failure")
    ) {
      const secret = JSON.parse(
        readFileSync(join(process.env.LEUCO_HOME!, "daemon.json"), "utf8"),
      ).token
      send({
        method: "turn/completed",
        params: {
          threadId,
          turn: {
            id: turnId,
            status: "failed",
            error: {
              message: `status-failure-probe ${"p".repeat(3970)}${secret}${"q".repeat(20000)}`,
            },
          },
        },
      })
      continue
    }
    if (
      process.env.LEUCO_VERIFY_TURN_TEXT_FILE &&
      existsSync(process.env.LEUCO_VERIFY_TURN_TEXT_FILE)
    ) {
      await Bun.sleep(20)
      const mode = readFileSync(process.env.LEUCO_VERIFY_TURN_TEXT_FILE, "utf8")
      const count = mode === "count" ? 10001 : mode === "deltas" ? 4 : 1
      for (const _ of Array.from({ length: count })) {
        if (mode === "deltas")
          send({
            method: "item/agentMessage/delta",
            params: { threadId, turnId, itemId: "large", delta: "x".repeat(600000) },
          })
        else
          send({
            method: "item/completed",
            params: {
              threadId,
              turnId,
              item: {
                type: "agentMessage",
                id: "large",
                text: mode === "count" ? "" : "x".repeat(2400000),
                phase: mode === "final" ? "final_answer" : null,
              },
            },
          })
      }
    }
    setTimeout(() => {
      send({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: "answer",
            text: "verified reply",
            phase: "final_answer",
          },
        },
      })
      send({
        method: "turn/completed",
        params: { threadId, turn: { id: turnId, status: "completed" } },
      })
    }, 20)
  } else send({ id: request.id, error: { code: -32601, message: "Unknown method" } })
}
