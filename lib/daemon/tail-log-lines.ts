export function tailLogLines(text: string, limit: number): string[] {
  if (text.length === 0 || limit < 1) return []
  const lines: string[] = []
  const position = { end: text.endsWith("\n") ? text.length - 1 : text.length }
  while (position.end >= 0 && lines.length < limit) {
    const start = position.end === 0 ? 0 : text.lastIndexOf("\n", position.end - 1) + 1
    const line = text.slice(start, position.end).replace(/\r$/, "")
    const end = /[\uD800-\uDBFF]/.test(line.charAt(16383)) ? 16383 : 16384
    lines.push(
      line.length <= 16384
        ? line
        : `${line.slice(0, end)} [truncated log line; original chars=${line.length}]`,
    )
    if (start === 0) break
    position.end = start - 1
  }
  return lines.reverse()
}
