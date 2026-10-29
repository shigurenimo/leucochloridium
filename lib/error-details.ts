import { errorMessage } from "@/error-message"

/** Bounded diagnostic snapshot; callers redact before persisting or returning it. */
export function errorDetails(error: unknown) {
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
    causes.push({
      name: current instanceof Error ? current.name : "Error",
      message: errorMessage(current).slice(0, 4000),
      stack: current instanceof Error ? (current.stack?.slice(0, 8000) ?? null) : null,
      code:
        typeof current === "object" && current !== null && "code" in current
          ? String(current.code).slice(0, 100)
          : null,
    })
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause)
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 8))
  }
  return causes
}
