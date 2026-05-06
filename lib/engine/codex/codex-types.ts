/** Outgoing param shapes for codex app-server JSON-RPC requests. */

export type ThreadStartParams = {
  cwd?: string
  model?: string
  approvalPolicy?: string
  sandbox?: string
  personality?: "friendly" | "pragmatic" | "none"
  serviceName?: string
  sessionStartSource?: "startup" | "clear"
  developerInstructions?: string
  baseInstructions?: string
}

export type ThreadResumeParams = {
  threadId: string
  cwd?: string
  developerInstructions?: string
  baseInstructions?: string
  /** When true, skip populating `thread.turns` to keep the response small. */
  excludeTurns?: boolean
}

export type TurnInputItem =
  | { type: "text"; text: string }
  | { type: "image"; url: string }
  | { type: "localImage"; path: string }
  | { type: "skill"; name: string; path: string }
  | { type: "mention"; name: string; path: string }

export type TurnStartParams = {
  threadId: string
  input: TurnInputItem[]
  cwd?: string
  model?: string
  effort?: string
  approvalPolicy?: string
}
