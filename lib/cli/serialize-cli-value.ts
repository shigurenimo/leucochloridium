import { redactPublicText } from "@/secrets/redact-public-text"
export function serializeCliValue(value: unknown, json: boolean): string {
  const encoded = redactPublicText(JSON.stringify(value))
  return json ? encoded : Bun.YAML.stringify(JSON.parse(encoded), null, 2)
}
