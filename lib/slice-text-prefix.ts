/** Keep a size-limited prefix without cutting a UTF-16 surrogate pair in half. */
export function sliceTextPrefix(text: string, maxChars: number): string {
  const prefix = text.slice(0, maxChars)
  const last = prefix.charCodeAt(prefix.length - 1)
  const next = text.charCodeAt(prefix.length)
  return last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
    ? prefix.slice(0, -1)
    : prefix
}
