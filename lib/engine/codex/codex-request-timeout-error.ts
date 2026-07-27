export class CodexRequestTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CodexRequestTimeoutError"
  }
}
