export function readDiagnosticProperty(value: unknown, key: string, fallback: unknown): unknown {
  try {
    if (value === null || (typeof value !== "object" && typeof value !== "function"))
      return undefined
    return Reflect.get(value, key)
  } catch {
    return fallback
  }
}
