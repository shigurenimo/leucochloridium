const DETAIL_LIMIT = 1_800

/** Keep the real failure while making it safe to place in a Slack code block. */
export const formatTurnFailureReply = (error: Error): string => {
  const normalized = error.message.trim() || error.name
  const redacted = redactSecrets(normalized).replace(/```/g, "` ` `")
  const detail =
    redacted.length <= DETAIL_LIMIT ? redacted : `${redacted.slice(0, DETAIL_LIMIT - 3)}...`
  return ["```", detail, "```"].join("\n")
}

const redactSecrets = (text: string): string => {
  return text
    .replace(
      /\b(Authorization["']?\s*[:=]\s*)["']?(?:(?:Bearer|Basic)\s+)?[^\s,;}"']+["']?/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Bearer)\s+[^\s,;]+/gi, "$1 [REDACTED]")
    .replace(/\b(xox[baprs]-)[A-Za-z0-9-]+/gi, "$1[REDACTED]")
    .replace(/\b(sk-(?:proj-)?)[A-Za-z0-9_-]{8,}/gi, "$1[REDACTED]")
    .replace(
      /\b((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*)["']?[^\s,;}"']+["']?/gi,
      "$1[REDACTED]",
    )
}
