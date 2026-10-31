import { afterEach, expect, it, vi } from "vitest"
import { MemoryDiagnosticOutput } from "@/memory-diagnostic-output"
import { writeCliText } from "@/cli/write-cli-text"

afterEach(() => vi.useRealTimers())
it.each<"stdout" | "stderr">(["stdout", "stderr"])(
  "preserves %s delivery causes",
  async (destination) => {
    const output = new MemoryDiagnosticOutput()
    output.failure = Object.assign(new Error("pipe closed"), { code: "EPIPE" })
    await expect(writeCliText("known result", { destination, output })).rejects.toMatchObject({
      code: "STATE_UNCERTAIN",
      details: {
        phase: "output-flush",
        destination,
        causes: [expect.objectContaining({ code: "EPIPE" })],
      },
    })
    expect(output.attempts).toEqual(["known result"])
  },
)
it("bounds output observation without replaying a stalled write", async () => {
  vi.useFakeTimers()
  const output = new MemoryDiagnosticOutput()
  const write = vi.spyOn(output, "write").mockReturnValue(new Promise<void>(() => {}))
  const failed = writeCliText("known result", { destination: "stdout", output }).then(
    () => null,
    (error: unknown) => error,
  )
  await vi.advanceTimersByTimeAsync(4000)
  expect(await failed).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "output-flush", destination: "stdout" },
  })
  expect(write).toHaveBeenCalledOnce()
})
