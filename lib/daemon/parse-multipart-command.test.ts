import { expect, it } from "vitest"
import { parseMultipartCommand } from "@/daemon/parse-multipart-command"

it("reads only a JSON text command field", () => {
  const form = new FormData()
  form.set("command", JSON.stringify({ words: ["slack", "upload-file"], flags: {} }))
  expect(parseMultipartCommand(form)).toEqual({ words: ["slack", "upload-file"], flags: {} })
  form.set("command", new Blob(["{}"]), "command.json")
  expect(() => parseMultipartCommand(form)).toThrow("must be JSON text")
})

it("limits UTF-8 bytes rather than character count before JSON parsing", () => {
  const form = new FormData()
  form.set("command", JSON.stringify("あ".repeat(1_400_000)))
  expect(() => parseMultipartCommand(form)).toThrow("exceeds 4194304 bytes")
})

it.each(["command", "file"])("rejects duplicate multipart %s fields", (field) => {
  const form = new FormData()
  form.set("command", JSON.stringify({ words: ["slack", "upload-file"], flags: {} }))
  form.set("file", new Blob(["first"]), "first.txt")
  form.append(field, field === "command" ? "{}" : new Blob(["second"]))
  expect(() => parseMultipartCommand(form)).toThrow("Duplicate multipart field")
})

it("rejects unused multipart fields instead of silently ignoring them", () => {
  const form = new FormData()
  form.set("command", "{}")
  form.set("attachment", new Blob(["unused bytes"]), "unused.txt")
  expect(() => parseMultipartCommand(form)).toThrow("Unsupported multipart field")
})

it.each<[string, (form: FormData) => void]>([
  ["a non-text command", (form) => form.set("command", new Blob(["{}"]), "command.json")],
  ["an oversized command", (form) => form.set("command", "x".repeat(4 * 1024 * 1024 + 1))],
  ["invalid command JSON", (form) => form.set("command", "{")],
  ["a missing command", () => {}],
])("classifies %s as a pre-execution control-body rejection", (_label, prepare) => {
  const form = new FormData()
  prepare(form)
  expect(() => parseMultipartCommand(form)).toThrow(
    expect.objectContaining({
      code: "USAGE",
      details: { phase: "control-body", executionStarted: false },
    }),
  )
})

it("retains the JSON syntax failure as cause", () => {
  const form = new FormData()
  form.set("command", "{")
  expect(() => parseMultipartCommand(form)).toThrow(
    expect.objectContaining({ cause: expect.any(SyntaxError) }),
  )
})
