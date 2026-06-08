/**
 * Quote a TOML basic multi-line string. Escapes embedded `"""` sequences so
 * the closing delimiter is unambiguous. The reader (`parseAgentToml` in
 * `LeucoCodexAgentStore.read`) reverses the escape on load.
 */
export const tomlMultiline = (value: string): string => {
  const escaped = value.replace(/"""/g, '\\"\\"\\"')
  return `"""\n${escaped}\n"""`
}
