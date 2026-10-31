import { readDiagnosticProperty } from "@/read-diagnostic-property"

/** OS APIs can include secret values in errors; retain only a safe diagnostic code. */
export function osCredentialError(operation: "read" | "save" | "delete", error: unknown): Error {
  const value = readDiagnosticProperty(error, "code", undefined)
  const rawCode = typeof value === "string" || typeof value === "number" ? String(value) : "unknown"
  const code = /^(?:[A-Z][A-Z0-9_]{0,79}|-?[0-9]{1,16})$/.test(rawCode) ? rawCode : "unknown"
  return new Error(
    `Cannot ${operation} OS credentials (OS error code: ${code}). Unlock or enable your OS credential store.`,
    {
      cause: new Error(
        `OS credential ${operation} failed; code=${code}. Raw OS message is excluded to protect secret values.`,
      ),
    },
  )
}
