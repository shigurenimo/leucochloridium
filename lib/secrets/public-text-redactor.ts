type RedactionRange = { start: number; end: number; queryMarker: boolean }
type Cursor = {
  iterator: Generator<RedactionRange, void, unknown>
  current: RedactionRange | null
}
type RedactionState = {
  active: RedactionRange | null
  position: number
  fragments: string[]
}

/** Merge matches from the original text so replacements cannot hide overlapping secrets. */
export class PublicTextRedactor {
  constructor(
    private readonly text: string,
    private readonly secrets: ReadonlyArray<string>,
  ) {
    Object.freeze(this)
  }

  redact(): string {
    const cursors = this.createCursors()
    const state: RedactionState = { active: null, position: 0, fragments: [] }
    while (true) {
      const range = this.nextRange(cursors)
      if (range === null) break
      this.acceptRange(state, range)
    }
    this.flushRange(state)
    state.fragments.push(this.text.slice(state.position))
    return state.fragments.join("")
  }

  private createCursors(): Cursor[] {
    return [
      this.knownRanges(),
      this.slackRanges(),
      this.socketRanges(),
      this.credentialRanges(),
    ].map((iterator) => {
      const first = iterator.next()
      return { iterator, current: first.done ? null : first.value }
    })
  }

  private nextRange(cursors: Cursor[]): RedactionRange | null {
    const cursor = cursors
      .filter((candidate) => candidate.current !== null)
      .sort(
        (left, right) => (left.current?.start ?? Infinity) - (right.current?.start ?? Infinity),
      )[0]
    if (cursor === undefined || cursor.current === null) return null
    const range = cursor.current
    const next = cursor.iterator.next()
    cursor.current = next.done ? null : next.value
    return range
  }

  private acceptRange(state: RedactionState, range: RedactionRange): void {
    const active = state.active
    if (active !== null && range.start < active.end) {
      active.end = Math.max(active.end, range.end)
      if (range.start === active.start) active.queryMarker &&= range.queryMarker
      return
    }
    this.flushRange(state)
    state.active = { ...range }
  }

  private flushRange(state: RedactionState): void {
    const active = state.active
    if (active === null) return
    if (state.position < active.start)
      state.fragments.push(this.text.slice(state.position, active.start))
    state.fragments.push(active.queryMarker ? "?[redacted]" : "[redacted]")
    state.position = active.end
    state.active = null
  }

  private *knownRanges(): Generator<RedactionRange, void, unknown> {
    const literals = [...new Set(this.secrets.filter(Boolean))]
      .sort((left, right) => right.length - left.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    if (literals.length === 0) return
    const pattern = new RegExp(`(?=(${literals.join("|")}))`, "g")
    for (const match of this.text.matchAll(pattern)) {
      const secret = match[1]
      if (secret === undefined || secret.length === 0) continue
      yield { start: match.index, end: match.index + secret.length, queryMarker: false }
    }
  }

  private *slackRanges(): Generator<RedactionRange, void, unknown> {
    for (const match of this.text.matchAll(/(?:xox[a-z][.-]|xapp-)[A-Za-z0-9._-]+/g))
      yield { start: match.index, end: match.index + match[0].length, queryMarker: false }
  }

  private *credentialRanges(): Generator<RedactionRange, void, unknown> {
    for (const match of this.text.matchAll(/((?:https?|wss?):\/\/)([^/\s"<>?#\\]+)@/gi)) {
      const scheme = match[1]
      const credentials = match[2]
      if (scheme === undefined || credentials === undefined) continue
      yield {
        start: match.index + scheme.length,
        end: match.index + scheme.length + credentials.length,
        queryMarker: false,
      }
    }
  }

  private *socketRanges(): Generator<RedactionRange, void, unknown> {
    for (const match of this.text.matchAll(/(wss?:\/\/[^\s"<>?#\\]+)(\?[^\s"'<>\\]*)?/gi)) {
      const endpoint = match[1]
      if (endpoint === undefined || match[2] === undefined) continue
      yield {
        start: match.index + endpoint.length,
        end: match.index + match[0].length,
        queryMarker: true,
      }
    }
  }
}
