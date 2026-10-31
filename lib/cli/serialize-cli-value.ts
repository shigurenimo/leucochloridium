import { redactPublicText } from "@/secrets/redact-public-text"
export function serializeCliValue(value: unknown, json: boolean): string {
  const escapeControls = (text: string): string =>
    text.replace(
      /[\u007f-\u009f\u2028\u2029]/gu,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
    )
  const encoded = escapeControls(redactPublicText(JSON.stringify(value)))
  if (json) return encoded

  const document: unknown = JSON.parse(encoded)
  const yaml = Bun.YAML.stringify(document, null, 2)
  // Bun can emit C1 controls in plain scalars; JSON is valid YAML and quotes every string.
  return /[\u007f-\u009f\u2028\u2029]/u.test(yaml)
    ? escapeControls(JSON.stringify(document, null, 2))
    : yaml
}
