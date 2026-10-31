import { readDiagnosticProperty } from "@/read-diagnostic-property"

/** A reported effect or unreadable observation must override a pre-execution error code. */
export function hasPossibleMutation(details: unknown): boolean {
  return [
    "mutationMayHaveOccurred",
    "executionStarted",
    "operationCompleted",
    "journalWritten",
  ].some((key) => readDiagnosticProperty(details, key, true) === true)
}
