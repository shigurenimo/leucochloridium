export const MAX_CLI_JSON_CHARS = 80_000

const MIN_CLI_JSON_CHARS = 512

/**
 * Keep CLI text safely below Codex's command-output ceiling. Oversized values
 * remain valid JSON and carry a preview, so the model can issue a narrower
 * paginated/filtering call instead of losing the entire turn.
 */
export const toBoundedJson = (value: unknown, maxChars = MAX_CLI_JSON_CHARS): string => {
  if (!Number.isSafeInteger(maxChars) || maxChars < MIN_CLI_JSON_CHARS) {
    throw new Error(`maxChars must be an integer >= ${MIN_CLI_JSON_CHARS}`)
  }

  const serialized = JSON.stringify(value, null, 2)
  const fullText = serialized ?? "null"
  if (fullText.length <= maxChars) return fullText

  const metadata = {
    truncated: true,
    originalChars: fullText.length,
    message:
      "CLI output was truncated before reaching Codex. Request a narrower page, cursor, limit, or filter.",
    continuation: continuationHints(value),
  }
  const emptyEnvelope = JSON.stringify({ _leuco: metadata, preview: "" }, null, 2)
  // Embedding a JSON preview can double every slash/quote. Reserve metadata
  // headroom, then budget at that worst-case expansion.
  const previewChars = Math.max(0, Math.floor((maxChars - emptyEnvelope.length - 256) / 2))
  const envelope = JSON.stringify(
    {
      _leuco: { ...metadata, previewChars },
      preview: fullText.slice(0, previewChars),
    },
    null,
    2,
  )

  if (envelope.length > maxChars) {
    throw new Error(`bounded CLI output invariant failed (${envelope.length} > ${maxChars})`)
  }
  return envelope
}

const continuationHints = (value: unknown): Record<string, string | number | boolean> | null => {
  const root = toRecord(value)
  if (root === null) return null

  const hints: Record<string, string | number | boolean> = {}
  const responseMetadata = toRecord(root.response_metadata)
  const messages = toRecord(root.messages)
  const paging = toRecord(root.paging) ?? toRecord(messages?.paging)
  const nextCursor =
    boundedNonEmptyString(responseMetadata?.next_cursor) ??
    boundedNonEmptyString(root.next_cursor) ??
    boundedNonEmptyString(root.next_page_token) ??
    boundedNonEmptyString(root.nextPageToken)

  if (nextCursor !== null) hints.nextCursor = nextCursor
  if (typeof root.has_more === "boolean") hints.hasMore = root.has_more

  const page = safeNumber(paging?.page)
  const pages = safeNumber(paging?.pages)
  const total = safeNumber(paging?.total)
  if (page !== null) hints.page = page
  if (pages !== null) hints.pages = pages
  if (total !== null) hints.total = total
  if (page !== null && pages !== null && page < pages) hints.nextPage = page + 1

  return Object.keys(hints).length > 0 ? hints : null
}

const toRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  return Object.fromEntries(Object.entries(value))
}

const boundedNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0) return null
  return value.slice(0, 512)
}

const safeNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null
}
