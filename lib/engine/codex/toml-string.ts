/**
 * Quote a single-line TOML basic-string value. Escapes backslashes first and
 * then double quotes, matching the inverse done by `parseAgentToml` in
 * `LeucoCodexAgentStore.read`. Round-trips with `tomlMultiline` for the
 * multiline cases used by codex agent TOMLs.
 */
export const tomlString = (value: string): string => {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
