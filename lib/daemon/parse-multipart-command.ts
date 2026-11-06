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
  if (typeof command !== "string") throw rejectCommandField("Multipart command must be JSON text")
  if (Buffer.byteLength(command, "utf8") > MAX_CONTROL_JSON_BYTES)
    throw rejectCommandField(`Multipart command exceeds ${MAX_CONTROL_JSON_BYTES} bytes`)
  try {
    return JSON.parse(command)
  } catch (error) {
    throw rejectCommandField("Multipart command is not valid JSON", error)
  }
}

function rejectCommandField(message: string, cause?: unknown): CliError {
  const failure = new CliError("USAGE", message, {
    phase: "control-body",
    executionStarted: false,
  })
  if (cause !== undefined) failure.cause = cause
  return failure
}
