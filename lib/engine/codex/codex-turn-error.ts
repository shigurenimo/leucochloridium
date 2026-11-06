/** A turn that Codex itself completed without success; `turnMessage` is Codex's own text. */
export class CodexTurnError extends Error {
  constructor(
    readonly turnId: string,
    readonly status: string,
    readonly turnMessage: string | null,
  ) {
    super(turnMessage ?? `codex turn ${turnId} ${status}`)
    this.name = "CodexTurnError"
  }
}
