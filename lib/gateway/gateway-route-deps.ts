import type { LeucoEngine } from "@/engine/engine"

export type GatewayRouteDeps = {
  selfPid: number
  engine: LeucoEngine
  /**
   * Bearer token required on every `/mcp/:project/:agent` request. Generated
   * once per daemon start, mirrored into each tenant's codex child env so
   * codex can present it. `null` disables MCP routing entirely.
   */
  mcpToken: string | null
}
