/**
 * Quote a single-line TOML basic-string value. Escapes backslashes first,
 * then double quotes, then the control characters TOML basic strings forbid
 * raw (tab/newline/CR named escapes, everything else as \uXXXX) — a value
 * containing a newline would otherwise produce an unparseable config.toml.
 * Round-trips with `tomlMultiline` for the multiline cases used by codex
 * agent TOMLs.
 */
export const tomlString = (value: string): string => {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(FORBIDDEN_CONTROL_CHARS, toUnicodeEscape)
  return `"${escaped}"`
}

// Matching control characters is the point here: TOML basic strings must not
// contain them raw, so every remaining one becomes a \uXXXX escape.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

const toUnicodeEscape = (char: string): string => {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
}
