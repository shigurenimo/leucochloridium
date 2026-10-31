/** Outgoing param shapes for codex app-server JSON-RPC requests. */

export type ThreadStartParams = {
  cwd?: string
  model?: string
  developerInstructions?: string
}

export type ThreadResumeParams = {
  threadId: string
  cwd?: string
}

export type TurnInputItem = { type: "text"; text: string }

export type TurnStartParams = {
  threadId: string
  input: TurnInputItem[]
  cwd?: string
}
