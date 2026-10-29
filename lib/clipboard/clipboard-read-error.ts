export class ClipboardReadError extends Error {
  constructor(
    readonly code: "UNAVAILABLE" | "FAILED" | "TIMEOUT" | "TOO_LARGE",
    message: string,
  ) {
    super(message)
    this.name = "ClipboardReadError"
  }
}
