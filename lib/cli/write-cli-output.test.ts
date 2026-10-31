import { beforeEach, expect, it } from "vitest"
import { writeCliOutput } from "@/cli/write-cli-output"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"

const output = new MemoryDiagnosticOutput()
const context = {
  json: true,
  command: "status",
  requestId: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d",
  output,
}
beforeEach(() => {
  output.attempts.length = 0
})

it("never prints a successful envelope for malformed status fields", async () => {
  await expect(writeCliOutput({ running: "yes" }, context)).rejects.toThrow("output contract")
  expect(output.attempts).toHaveLength(0)
})
it("does not present incomplete running status as authoritative", async () => {
  await expect(writeCliOutput({ running: true, ready: true }, context)).rejects.toThrow(
    "output contract",
  )
  expect(output.attempts).toHaveLength(0)
})
it("validates the serialized document when undefined would remove required data", async () => {
  await expect(writeCliOutput(undefined, { ...context, command: "slack call" })).rejects.toThrow(
    "output contract",
  )
  expect(output.attempts).toHaveLength(0)
})
it("keeps the existing structured version output valid", async () => {
  await writeCliOutput({ version: "0.18.0" }, { ...context, command: "version" })
  expect(output.attempts[0]).toContain('"data":{"version":"0.18.0"}')
})
it("preserves valid runtime diagnostics without stripping nested fields", async () => {
  await writeCliOutput(
    {
      running: true,
      ready: false,
      pid: 42,
      cwd: "/work",
      runtime: { diagnostic: { latest: "retained" } },
    },
    context,
  )
  expect(output.attempts[0]).toContain('"diagnostic":{"latest":"retained"}')
})
