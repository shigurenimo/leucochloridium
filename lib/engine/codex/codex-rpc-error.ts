export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    readonly rpcMessage: string,
  ) {
    super(`${rpcMessage} (code ${code})`)
    this.name = "CodexRpcError"
  }
}
