type Recovery = { attempt: number; startedAt: number }

/** Crash loops are bounded; an explicit manual restart begins a fresh window. */
export function getRecoveryWindow(previous: Recovery | null, now: number): Recovery {
  if (previous === null || now - previous.startedAt >= 60000) return { attempt: 1, startedAt: now }
  return { attempt: previous.attempt + 1, startedAt: previous.startedAt }
}
