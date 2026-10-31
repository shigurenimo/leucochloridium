import type { ZodType } from "zod"
import { CliError } from "@/cli/cli-error"
import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"

/** Call only before invoking an operation, so rejection metadata cannot hide accepted work. */
export function parseControlInput<T>(
  schema: ZodType<T>,
  input: unknown,
  secrets: ReadonlyArray<string>,
): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const failure = new CliError(
    "USAGE",
    "Invalid control input; inspect validation issues before retrying",
    {
      phase: "validation",
      executionStarted: false,
      ...getBoundedValidationIssues(parsed.error, secrets),
    },
  )
  failure.cause = parsed.error
  throw failure
}
