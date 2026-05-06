/**
 * Drain stdin to a single string, trimming the trailing newline that shells
 * append. Used by token-accepting flags to support `--bot-token -` so secrets
 * don't end up in shell history or `ps` argv.
 */
export const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks)
    .toString("utf8")
    .replace(/\r?\n$/, "")
}
