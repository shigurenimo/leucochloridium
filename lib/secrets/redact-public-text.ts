type RedactionRange = { start: number; end: number; queryMarker: boolean }

/** Merge matches from the original text so replacements cannot hide overlapping secrets. */
export function redactPublicText(text: string, secrets: ReadonlyArray<string> = []): string {
  const ranges = [
    ...knownRanges(text, secrets),
    ...slackRanges(text),
    ...socketRanges(text),
    ...credentialRanges(text),
  ].sort((left, right) => left.start - right.start)
  const merged: RedactionRange[] = []
  for (const range of ranges) {
    const active = merged.at(-1)
    if (active === undefined || range.start >= active.end) {
      merged.push({ ...range })
      continue
    }
    active.end = Math.max(active.end, range.end)
    if (range.start === active.start) active.queryMarker &&= range.queryMarker
  }
  const fragments = merged.flatMap((range, index) => [
    text.slice(merged[index - 1]?.end ?? 0, range.start),
    range.queryMarker ? "?[redacted]" : "[redacted]",
  ])
  return [...fragments, text.slice(merged.at(-1)?.end ?? 0)].join("")
}

function knownRanges(text: string, secrets: ReadonlyArray<string>): RedactionRange[] {
  const literals = [...new Set(secrets.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  if (literals.length === 0) return []
  const pattern = new RegExp(`(?=(${literals.join("|")}))`, "g")
  return [...text.matchAll(pattern)].flatMap((match) => {
    const secret = match[1]
    if (secret === undefined || secret.length === 0) return []
    return [{ start: match.index, end: match.index + secret.length, queryMarker: false }]
  })
}

function slackRanges(text: string): RedactionRange[] {
  return [...text.matchAll(/(?:xox[a-z][.-]|xapp-)[A-Za-z0-9._-]+/g)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    queryMarker: false,
  }))
}

function socketRanges(text: string): RedactionRange[] {
  return [...text.matchAll(/(wss?:\/\/[^\s"<>?#\\]+)(\?[^\s"'<>\\]*)?/gi)].flatMap((match) => {
    const endpoint = match[1]
    if (endpoint === undefined || match[2] === undefined) return []
    return [
      {
        start: match.index + endpoint.length,
        end: match.index + match[0].length,
        queryMarker: true,
      },
    ]
  })
}

function credentialRanges(text: string): RedactionRange[] {
  return [...text.matchAll(/((?:https?|wss?):\/\/)([^/\s"<>?#\\]+)@/gi)].flatMap((match) => {
    const scheme = match[1]
    const credentials = match[2]
    if (scheme === undefined || credentials === undefined) return []
    return [
      {
        start: match.index + scheme.length,
        end: match.index + scheme.length + credentials.length,
        queryMarker: false,
      },
    ]
  })
}
