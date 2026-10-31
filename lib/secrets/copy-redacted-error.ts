import { errorDetails } from "@/error-details"
import { errorFromDetails } from "@/error-from-details"

/** Copy a bounded diagnostic chain; never retain references to unredacted errors. */
export function copyRedactedError(error: unknown, secrets: ReadonlyArray<string>): Error {
  return errorFromDetails(errorDetails(error, secrets))
}
