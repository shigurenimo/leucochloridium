import { CliError } from "@/cli/cli-error"
import { validateRunAt } from "@/connectors/schedule/validate-run-at"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"

export function parseScheduleTime(value: string, location = "--run-at"): string {
  try {
    return validateRunAt(value)
  } catch (error) {
    throw new CliError("USAGE", `Invalid ${location}: ${errorMessage(error)}`, {
      location,
      causes: errorDetails(error),
    })
  }
}
