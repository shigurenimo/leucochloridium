export function errorMessage(error: unknown): string {
  try {
    return String(error instanceof Error ? error.message : error)
  } catch {
    return "[unprintable thrown value]"
  }
}
