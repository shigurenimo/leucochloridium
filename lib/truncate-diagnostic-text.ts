export function truncateDiagnosticText(text: string, maxChars: number): string {
  const marker = " [truncated]"
  if (!Number.isSafeInteger(maxChars) || maxChars < marker.length)
    throw new Error("Diagnostic text limit must fit the truncation marker")
  if (text.length <= maxChars) return text
  const prefix = text.slice(0, maxChars - marker.length)
  const last = prefix.charCodeAt(prefix.length - 1)
  return `${last >= 0xd800 && last <= 0xdbff ? prefix.slice(0, -1) : prefix}${marker}`
}
