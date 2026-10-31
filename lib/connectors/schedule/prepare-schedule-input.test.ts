import { expect, it } from "vitest"
import { settingsSchema } from "@/config/config-schema"
import { prepareScheduleInput } from "@/connectors/schedule/prepare-schedule-input"

it.each(["", "   ", "\n\t", "　"])("rejects a blank scheduled prompt: %j", (prompt) => {
  const entry = { id: "one", name: "one", runAt: "* * * * *", prompt }
  expect(() => prepareScheduleInput(entry)).toThrow()
  expect(settingsSchema.safeParse({ schedules: [entry] }).success).toBe(false)
})

it("preserves whitespace in meaningful scheduled content", () => {
  const prompt = "  code\n\tline　 "
  const entry = { id: "one", name: "one", runAt: "* * * * *", prompt }
  expect(prepareScheduleInput(entry).text).toContain(`\n${prompt}\n</schedule>`)
  expect(settingsSchema.parse({ schedules: [entry] }).schedules[0]?.prompt).toBe(prompt)
})
import { MAX_TURN_INPUT_BYTES } from "@/turn-input-limits"

it("accepts the exact formatted byte budget and rejects one extra byte", () => {
  const entry = { id: "x".repeat(503), name: "check", runAt: "* * * * *", prompt: "x" }
  const overhead = Buffer.byteLength(prepareScheduleInput(entry).text) - 1
  const boundary = { ...entry, prompt: "x".repeat(MAX_TURN_INPUT_BYTES - overhead) }
  expect(Buffer.byteLength(prepareScheduleInput(boundary).text)).toBe(MAX_TURN_INPUT_BYTES)
  expect(settingsSchema.safeParse({ schedules: [boundary] }).success).toBe(true)
  expect(prepareScheduleInput(boundary).threadKey).toHaveLength(512)
  expect(() => prepareScheduleInput({ ...boundary, prompt: `${boundary.prompt}x` })).toThrow(
    "UTF-8 bytes",
  )
})
