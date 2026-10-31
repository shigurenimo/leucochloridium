import type { CliError } from "@/cli/cli-error"
import { hasPossibleMutation } from "@/cli/has-possible-mutation"
import { errorDetails } from "@/error-details"

/** Isolate diagnostic serialization failure from delivery of the original CLI error. */
export function snapshotCliErrorDetails(failure: CliError) {
  try {
    const original = failure.details
    const mutationPossible = hasPossibleMutation(original)
    const encoded = JSON.stringify(original)
    if (encoded === undefined) throw new Error("CLI error details have no JSON representation")
    const details: unknown = JSON.parse(encoded)
    return { details, mutationPossible: mutationPossible || hasPossibleMutation(details) }
  } catch (serialization) {
    return {
      mutationPossible: true,
      details: {
        phase: "error-details",
        originalDetailsAvailable: false,
        causes: errorDetails(
          new AggregateError(
            [failure, serialization],
            "CLI error details could not be serialized",
            {
              cause: failure,
            },
          ),
        ),
      },
    }
  }
}
