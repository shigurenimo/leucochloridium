import { CliError } from "@/cli/cli-error"
import { Buffer } from "node:buffer"
import { MAX_CONTROL_JSON_BYTES } from "@/daemon/control-input-limits"

export function parseMultipartCommand(form: {
  keys(): Iterable<string>
  get(name: string): unknown
  getAll(name: string): ReadonlyArray<unknown>
}): unknown {
  for (const field of form.keys()) {
    if (field !== "command" && field !== "file")
      throw new CliError("USAGE", `Unsupported multipart field: ${field}`, {
        phase: "validation",
        executionStarted: false,
      })
    if (form.getAll(field).length > 1)
      throw new CliError("USAGE", `Duplicate multipart field: ${field}`, {
        phase: "validation",
        executionStarted: false,
      })
  }
  const command = form.get("command")
  if (typeof command !== "string") throw new Error("Multipart command must be JSON text")
  if (Buffer.byteLength(command, "utf8") > MAX_CONTROL_JSON_BYTES)
    throw new Error(`Multipart command exceeds ${MAX_CONTROL_JSON_BYTES} bytes`)
  return JSON.parse(command)
}
