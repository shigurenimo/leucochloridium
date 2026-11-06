import { sliceTextPrefix } from "@/slice-text-prefix"

export function truncateDiagnosticText(text: string, maxChars: number): string {
  const marker = " [truncated]"
  if (!Number.isSafeInteger(maxChars) || maxChars < marker.length)
    throw new Error("Diagnostic text limit must fit the truncation marker")
  if (text.length <= maxChars) return text
  return `${sliceTextPrefix(text, maxChars - marker.length)}${marker}`
}
