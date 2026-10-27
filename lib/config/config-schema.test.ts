import { describe, expect, it } from "vitest"
import { settingsSchema } from "@/config/config-schema"

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
