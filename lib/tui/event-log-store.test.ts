import { describe, expect, test } from "vitest"
import type { LeucoEvent } from "@/events/leuco-event-types"
import { LeucoEventLogStore } from "@/tui/event-log-store"

const logEvent = (line: string): LeucoEvent => ({
  ts: 0,
  type: "log",
  level: "info",
  line,
})

describe("LeucoEventLogStore", () => {
  test("starts with an empty snapshot", () => {
    const store = new LeucoEventLogStore()
    expect(store.getSnapshot()).toEqual([])
  })

  test("push appends to the snapshot", () => {
    const store = new LeucoEventLogStore()
    store.push(logEvent("a"))
    store.push(logEvent("b"))

    expect(store.getSnapshot().map((event) => (event.type === "log" ? event.line : ""))).toEqual([
      "a",
      "b",
    ])
  })

  test("snapshot reference changes on each push", () => {
    const store = new LeucoEventLogStore()
    const initial = store.getSnapshot()

    store.push(logEvent("a"))

    expect(store.getSnapshot()).not.toBe(initial)
  })

  test("snapshot is bounded by capacity", () => {
    const store = new LeucoEventLogStore({ capacity: 2 })

    store.push(logEvent("a"))
    store.push(logEvent("b"))
    store.push(logEvent("c"))
    store.push(logEvent("d"))

    expect(store.getSnapshot().map((event) => (event.type === "log" ? event.line : ""))).toEqual([
      "c",
      "d",
    ])
  })

  test("subscribe fires the listener on each push", () => {
    const store = new LeucoEventLogStore()
    let count = 0
    store.subscribe(() => {
      count++
    })

    store.push(logEvent("a"))
    store.push(logEvent("b"))

    expect(count).toBe(2)
  })

  test("unsubscribing stops further notifications", () => {
    const store = new LeucoEventLogStore()
    let count = 0
    const off = store.subscribe(() => {
      count++
    })

    store.push(logEvent("a"))
    off()
    store.push(logEvent("b"))

    expect(count).toBe(1)
  })
})
