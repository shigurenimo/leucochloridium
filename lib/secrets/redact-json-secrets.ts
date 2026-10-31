import { redactPublicText } from "@/secrets/redact-public-text"

/** Capture a JSON snapshot and mask escaped secrets without corrupting quotes or backslashes. */
export function redactJsonSecrets(value: unknown, secrets: ReadonlyArray<string>): unknown {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) return value
  const safe = redactPublicText(
    encoded,
    secrets.filter(Boolean).map((secret) => JSON.stringify(secret).slice(1, -1)),
  )
  return JSON.parse(safe)
}
