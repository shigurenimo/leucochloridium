import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { readDiagnosticProperty } from "@/read-diagnostic-property"
import { readDiagnosticCauses } from "@/read-diagnostic-causes"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"
import { errorMessage } from "@/error-message"

/** Mask before truncation so a cutoff cannot expose part of a known secret. */
export function errorDetails(
  error: unknown,
  secrets: ReadonlyArray<string> = [],
  redactText?: (text: string) => string,
) {
  const bounded = (value: unknown, maxChars: number): string => {
    try {
      const text = String(value)
      const safe = redactText === undefined ? text : redactText(text)
      return truncateDiagnosticText(redactPublicText(safe, secrets), maxChars)
    } catch {
      return "[unprintable diagnostic value]"
    }
  }
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  const causes: Array<{
    name: string
    message: string
    stack: string | null
    code: string | null
  }> = []
  while (pending.length > 0 && causes.length < 8) {
    const current = pending.shift()
    if (seen.has(current)) continue
    seen.add(current)
    const kind = (() => {
      try {
        return { isError: current instanceof Error, isAggregate: current instanceof AggregateError }
      } catch {
        return { isError: false, isAggregate: false }
      }
    })()
    const stack = kind.isError
      ? readDiagnosticProperty(current, "stack", "[unreadable stack]")
      : null
    const code = readDiagnosticProperty(current, "code", "[unreadable code]")
    causes.push({
      name: bounded(
        kind.isError ? readDiagnosticProperty(current, "name", "[unreadable name]") : "Error",
        100,
      ),
      message: bounded(errorMessage(current), MAX_DIAGNOSTIC_MESSAGE_CHARACTERS),
      stack: stack === undefined || stack === null ? null : bounded(stack, 8000),
      code: code === undefined || code === null ? null : bounded(code, 100),
    })
    pending.push(...readDiagnosticCauses(current, kind))
  }
  return causes
}
