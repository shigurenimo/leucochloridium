import { PublicTextRedactor } from "@/secrets/public-text-redactor"

export function redactPublicText(text: string, secrets: ReadonlyArray<string> = []): string {
  return new PublicTextRedactor(text, secrets).redact()
}
