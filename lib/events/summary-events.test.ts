import { describe, expect, it } from "vitest"
import { LeucoEventLog } from "@/events/leuco-event-log"

describe("diagnostic event summary", () => {
  it("filters noise before limiting and preserves failures, request filters and sequence order", () => {
    const log = new LeucoEventLog()
    log.append({ ts: 1, type: "runtime.started", runtime: "leuco", requestId: "wanted" })
    log.log("warn", "warning", "wanted")
    log.log("error", "other failure", "other")
    for (const index of Array.from({ length: 20 }).keys()) {
      log.log("info", `noise ${index}`, "wanted")
      log.append({
        ts: index + 2,
        type: "codex.notification",
        runtime: "leuco",
        method: "hook/completed",
        params: {},
        requestId: "wanted",
      })
    }
    expect(
      log
        .query({ summary: true, requestId: "wanted", limit: 2, order: "desc" })
        .map((entry) => entry.event.type),
    ).toEqual(["runtime.started", "log"])
    expect(
      log.query({ summary: true, type: "log", limit: 1, order: "desc" })[0]?.event,
    ).toMatchObject({ level: "error", line: "other failure" })
    expect(log.query({ limit: 1, order: "desc" })[0]?.event.type).toBe("codex.notification")
    log.close()
  })
})
