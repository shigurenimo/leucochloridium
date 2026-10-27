#!/usr/bin/env bun
import { appendFileSync } from "node:fs"
import { createInterface } from "node:readline"

const state = { threads: 0, turns: 0 }
const send = (frame: unknown): void => {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}
appendFileSync(
  process.env.LEUCO_VERIFY_TRACE!,
  `${JSON.stringify({ env: { CODEX_HOME: process.env.CODEX_HOME, LEUCO_HOME: process.env.LEUCO_HOME }, args: process.argv.slice(2) })}\n`,
)
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  appendFileSync(process.env.LEUCO_VERIFY_TRACE!, `${JSON.stringify(request)}\n`)
  if (request.id === undefined) continue
  if (request.method === "initialize") send({ id: request.id, result: {} })
  else if (request.method === "config/read")
    send({ id: request.id, result: { config: { developer_instructions: "native instruction" } } })
  else if (request.method === "thread/start")
    send({ id: request.id, result: { thread: { id: `thread-${process.pid}-${++state.threads}` } } })
  else if (request.method === "thread/resume")
    send({ id: request.id, result: { thread: { id: request.params.threadId } } })
  else if (request.method === "turn/start") {
    const threadId = request.params.threadId
    const turnId = `turn-${++state.turns}`
    send({ id: request.id, result: { turn: { id: turnId } } })
    if (request.params.input?.some((entry: { text?: string }) => entry.text === "hold")) continue
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
