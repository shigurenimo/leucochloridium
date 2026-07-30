export function commandOutputOverflowCallId(error: Error): string | null {
  const match = error.message.match(
    /(?:^|:\s*)codex command output exceeded \d+ chars from ((?:call_|exec-)[a-z0-9_-]+)/i,
  )

  return match?.[1] ?? null
}
