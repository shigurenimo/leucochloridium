import { serializeCliValue } from "@/cli/serialize-cli-value"
import { CliError } from "@/cli/cli-error"
type Context = { json: boolean; command: string; requestId: string; signal?: AbortSignal }
export function writeCliOutput(value: unknown, context: Context): void {
  if (context.signal?.aborted)
    throw new CliError(
      "STATE_UNCERTAIN",
      "CLI deadline expired; inspect current state before retrying",
    )
  process.stdout.write(
    `${serializeCliValue({ schemaVersion: 1, ok: true, command: context.command, requestId: context.requestId, data: value }, context.json)}\n`,
  )
}
