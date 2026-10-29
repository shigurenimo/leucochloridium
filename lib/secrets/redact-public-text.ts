export function redactPublicText(text: string): string {
  return text.replace(/\b(?:xox[a-z][.-]|xapp-)[A-Za-z0-9._-]+/g, "[redacted]")
}
