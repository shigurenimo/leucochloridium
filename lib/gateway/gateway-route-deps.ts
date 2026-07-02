import type { LeucoEngine } from "@/engine/engine"

export type GatewayRouteDeps = {
  selfPid: number
  engine: LeucoEngine
  /**
   * Resolves the bearer token required on `/mcp/:project` for one project.
   * Tokens are per-tenant (generated once per daemon start), so one tenant's
   * codex child cannot call another tenant's MCP route with its own token.
   * `null` disables MCP routing entirely.
   */
  mcpTokenForProject: ((projectId: string) => string | null) | null
}
