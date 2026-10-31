/** Keep a size-limited suffix without cutting a UTF-16 surrogate pair in half. */
export function sliceTextSuffix(text: string, maxChars: number): string {
  const start = Math.max(0, text.length - maxChars)
  const previous = text.charCodeAt(start - 1)
  const first = text.charCodeAt(start)
  return text.slice(
    start +
      (previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff ? 1 : 0),
  )
}
