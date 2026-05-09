import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { tailEventsJsonl } from "@/tui/utils/tail-events-jsonl"

describe("tailEventsJsonl", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "leuco-tail-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("replays existing lines on start", () => {
    const path = join(dir, "events.jsonl")
    writeFileSync(path, `${JSON.stringify({ ts: 1, type: "log", level: "info", line: "hello" })}\n`)

    const received: LeucoEvent[] = []
    const stop = tailEventsJsonl({ path, onEvent: (event) => received.push(event) })

    expect(received).toHaveLength(1)
    stop()
  })

  it("does not throw when the target file does not exist yet", async () => {
    const path = join(dir, "events.jsonl")
    const received: LeucoEvent[] = []

    const stop = tailEventsJsonl({ path, onEvent: (event) => received.push(event) })

    appendFileSync(
      path,
      `${JSON.stringify({ ts: 2, type: "log", level: "info", line: "later" })}\n`,
    )

    await new Promise((resolve) => setTimeout(resolve, 50))
    stop()
  })

  it("skips malformed JSON lines without crashing", () => {
    const path = join(dir, "events.jsonl")
    const lines = [
      JSON.stringify({ ts: 1, type: "log", level: "info", line: "good" }),
      "{ this is not valid json",
      JSON.stringify({ ts: 2, type: "log", level: "info", line: "also good" }),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`)

    const received: LeucoEvent[] = []
    const stop = tailEventsJsonl({ path, onEvent: (event) => received.push(event) })

    expect(received).toHaveLength(2)
    stop()
  })

  it("skips lines that do not match the event schema", () => {
    const path = join(dir, "events.jsonl")
    const lines = [
      JSON.stringify({ ts: 1, type: "made.up", payload: 1 }),
      JSON.stringify({ ts: 2, type: "log", level: "info", line: "ok" }),
    ]
    writeFileSync(path, `${lines.join("\n")}\n`)

    const received: LeucoEvent[] = []
    const stop = tailEventsJsonl({ path, onEvent: (event) => received.push(event) })

    expect(received).toHaveLength(1)
    expect(received[0]!.type).toBe("log")
    stop()
  })
})
