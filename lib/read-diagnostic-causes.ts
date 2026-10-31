import { readDiagnosticProperty } from "@/read-diagnostic-property"

export function readDiagnosticCauses(
  value: unknown,
  kind: { isError: boolean; isAggregate: boolean },
): ReadonlyArray<unknown> {
  const causes: unknown[] = []
  if (kind.isError) {
    const cause = readDiagnosticProperty(value, "cause", "[unreadable cause]")
    if (cause !== undefined) causes.push(cause)
  }
  if (!kind.isAggregate) return causes
  const errors = readDiagnosticProperty(value, "errors", "[unreadable errors]")
  const count = (() => {
    try {
      return Array.isArray(errors) ? readDiagnosticProperty(errors, "length", -1) : -1
    } catch {
      return -1
    }
  })()
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    causes.push("[unreadable aggregate causes]")
    return causes
  }
  for (const index of Array.from({ length: Math.min(count, 8) }).keys())
    causes.push(readDiagnosticProperty(errors, String(index), "[unreadable aggregate cause]"))
  return causes
}
