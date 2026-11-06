import { MAX_DIAGNOSTIC_MESSAGE_CHARACTERS } from "@/diagnostic-limits"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

/** Mask before truncation so a cutoff cannot expose part of a known secret. */
export function toPublicDiagnosticMessage(text: string, secrets?: ReadonlyArray<string>): string {
  return truncateDiagnosticText(redactPublicText(text, secrets), MAX_DIAGNOSTIC_MESSAGE_CHARACTERS)
}
