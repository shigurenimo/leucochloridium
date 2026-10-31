import { describe, expect, it } from "vitest"
import { settingsSchema, stateSchema } from "@/config/config-schema"

describe("one companion settings", () => {
  it("defaults to native Codex settings and no added instructions", () => {
    expect(settingsSchema.parse({})).toMatchObject({
      version: 4,
      cwd: null,
      soul: null,
      model: null,
      slack: null,
      schedules: [],
    })
  })
  it.each([
    { projects: [] },
    { connectors: [] },
    { cwd: "relative" },
    { soul: "relative" },
    { approvalPolicy: "never" },
    { turnTimeoutMs: 0 },
    { model: " " },
    { model: "\n\t" },
    { model: "　" },
  ])("rejects legacy or unsupported settings %j", (settings) => {
    expect(settingsSchema.safeParse(settings).success).toBe(false)
  })
  it("rejects duplicate schedule names", () => {
    const entry = { id: "one", name: "check", runAt: "* * * * *", prompt: "check" }
    expect(settingsSchema.safeParse({ schedules: [entry, { ...entry, id: "two" }] }).success).toBe(
      false,
    )
  })
})

it.each(["turnTimeoutMs", "idleTimeoutMs"])("rejects %s above the native timer range", (key) => {
  expect(settingsSchema.safeParse({ [key]: 2147483648 }).success).toBe(false)
  expect(settingsSchema.safeParse({ [key]: 2147483647 }).success).toBe(true)
})

it.each(["not-a-time", "* * * *", "2026-07-03 10:00"])(
  "rejects an unparseable schedule runAt %s",
  (runAt) => {
    expect(
      settingsSchema.safeParse({
        schedules: [{ id: "one", name: "check", runAt, prompt: "check" }],
      }).success,
    ).toBe(false)
  },
)
it("keeps stored past one-shot schedules readable for durable catch-up", () => {
  expect(
    settingsSchema.safeParse({
      schedules: [{ id: "one", name: "check", runAt: "2000-01-01T00:00:00Z", prompt: "check" }],
    }).success,
  ).toBe(true)
})

it("rejects a scheduled prompt that exceeds queue capacity after context is added", () => {
  const entry = { id: "one", name: "check", runAt: "* * * * *", prompt: "x".repeat(256 * 1024) }
  expect(settingsSchema.safeParse({ schedules: [entry] }).success).toBe(false)
})
it("counts scheduled Unicode input in UTF-8 bytes", () => {
  const entry = {
    id: "one",
    name: "check",
    runAt: "* * * * *",
    prompt: "あ".repeat(Math.floor((256 * 1024) / 3)),
  }
  expect(settingsSchema.safeParse({ schedules: [entry] }).success).toBe(false)
})
it("rejects a schedule ID that cannot fit its runtime conversation key", () => {
  const entry = { id: "x".repeat(504), name: "check", runAt: "* * * * *", prompt: "check" }
  expect(settingsSchema.safeParse({ schedules: [entry] }).success).toBe(false)
})

it("preserves literal record keys without changing object prototypes", () => {
  const state = stateSchema.parse(
    JSON.parse(
      '{"threads":{"__proto__":{"id":"saved","context":"context"}},"scheduleLastFiredAt":{"__proto__":123},"scheduleLastRunAt":{"__proto__":"2026-05-07T09:30:00Z"}}',
    ),
  )
  expect(Object.hasOwn(state.threads, "__proto__")).toBe(true)
  expect(Object.hasOwn(state.scheduleLastFiredAt, "__proto__")).toBe(true)
  expect(Object.hasOwn(state.scheduleLastRunAt ?? {}, "__proto__")).toBe(true)
  expect(Object.getPrototypeOf(state.threads)).toBe(Object.prototype)
  expect(JSON.stringify(state)).toContain('"__proto__"')
})

it("reads legacy schedule decisions and validates optional scheduled-time records", () => {
  const legacy = stateSchema.parse({ scheduleLastFiredAt: { saved: 123 } })
  expect(legacy.scheduleLastFiredAt.saved).toBe(123)
  expect(legacy.scheduleLastRunAt).toBeUndefined()
  expect(() => stateSchema.parse({ scheduleLastRunAt: { saved: "not a schedule" } })).toThrow()
})
