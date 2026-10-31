import { serializeCliValue } from "@/cli/serialize-cli-value"
import { CliError } from "@/cli/cli-error"
import { z } from "zod"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { getCliOutputSchema } from "@/cli/get-cli-output-schema"
import { VERSION_RESULT_SCHEMA } from "@/cli/command-catalog"
import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"
import { writeCliText } from "@/cli/write-cli-text"
import type { DiagnosticOutput } from "@/diagnostic-output"
type Context = {
  json: boolean
  command: string
  requestId: string
  signal?: AbortSignal
  output?: DiagnosticOutput
}
export async function writeCliOutput(value: unknown, context: Context): Promise<void> {
  if (context.signal?.aborted)
    throw new CliError(
      "STATE_UNCERTAIN",
      "CLI deadline expired; inspect current state before retrying",
    )
  const encoded = serializeCliValue(
    {
      schemaVersion: 1,
      ok: true,
      command: context.command,
      requestId: context.requestId,
      data: value,
    },
    true,
  )
  const document: unknown = JSON.parse(encoded)
  const schema =
    context.command === "version"
      ? getCliOutputSchema("version", VERSION_RESULT_SCHEMA)
      : getCliSpecification(context.command.split(" ")).commands.find(
          (command) => command.name === context.command,
        )?.outputSchema
  if (schema === undefined)
    throw new CliError(
      "STATE_UNCERTAIN",
      "CLI output contract is unavailable; inspect state before retrying",
    )
  const validation = z.fromJSONSchema(schema).safeParse(document)
  if (!validation.success) {
    const failure = new CliError(
      "STATE_UNCERTAIN",
      "CLI result does not match the published output contract; inspect state before retrying",
      {
        phase: "output",
        ...getBoundedValidationIssues(validation.error),
      },
    )
    failure.cause = validation.error
    throw failure
  }
  if (context.signal?.aborted)
    throw new CliError(
      "STATE_UNCERTAIN",
      "CLI deadline expired before output; inspect state before retrying",
    )
  await writeCliText(`${context.json ? encoded : serializeCliValue(document, false)}\n`, {
    destination: "stdout",
    output: context.output,
  })
}
