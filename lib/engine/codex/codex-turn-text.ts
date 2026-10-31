export const codexTurnTextMaxBytes = 2 * 1024 * 1024
export const codexTurnTextMaxFragments = 10000

export class CodexTurnText {
  private readonly deltas: string[] = []
  private readonly legacyTexts: string[] = []
  private readonly finalTexts: string[] = []
  private readonly state = { bytes: 0, fragments: 0, hasExplicitPhase: false }

  constructor() {
    Object.freeze(this)
  }

  appendDelta(text: string): void {
    if (text.length === 0) return
    this.reserve(text)
    this.deltas.push(text)
  }

  complete(text: string, phase: string | null | undefined): void {
    if (typeof phase !== "string" || phase === "final_answer") this.reserve(text)
    if (typeof phase === "string") this.state.hasExplicitPhase = true
    else this.legacyTexts.push(text)
    if (phase === "final_answer") this.finalTexts.push(text)
  }

  getText(): string {
    if (this.finalTexts.length > 0) return this.finalTexts.join("\n\n")
    if (this.state.hasExplicitPhase) return ""
    if (this.legacyTexts.length > 0) return this.legacyTexts.join("\n\n")
    return this.deltas.join("")
  }

  clear(): void {
    this.deltas.splice(0)
    this.legacyTexts.splice(0)
    this.finalTexts.splice(0)
    this.state.bytes = 0
    this.state.fragments = 0
    this.state.hasExplicitPhase = false
  }

  private reserve(text: string): void {
    const bytes = this.state.bytes + Buffer.byteLength(text)
    const fragments = this.state.fragments + 1
    if (bytes > codexTurnTextMaxBytes || fragments > codexTurnTextMaxFragments)
      throw Object.assign(
        new Error(
          `Codex turn text exceeded limit: ${bytes} bytes, ${fragments} fragments (maximum ${codexTurnTextMaxBytes} bytes / ${codexTurnTextMaxFragments} fragments)`,
        ),
        { code: "CODEX_TURN_TEXT_LIMIT" },
      )
    this.state.bytes = bytes
    this.state.fragments = fragments
  }
}
