import type { Server } from "bun"
import { buildGatewayApp } from "@/gateway/build-gateway-app"
import type { LeucoEngine } from "@/engine/engine"

type Props = {
  engine: LeucoEngine
  port: number
  mcpTokenForProject: (projectId: string) => string | null
  selfPid?: number
  onLog?: (line: string) => void
}

/**
 * In-process HTTP gateway: runs `Bun.serve` against the Hono app built by
 * `buildGatewayApp`. Started by the engine on every run — the MCP route at
 * `/mcp/:project` depends on it.
 */
export class LeucoGatewayServer {
  private readonly engine: LeucoEngine
  private readonly port: number
  private readonly selfPid: number
  private readonly onLog: ((line: string) => void) | undefined
  private readonly mcpTokenForProject: (projectId: string) => string | null
  private server: Server<undefined> | null = null

  constructor(props: Props) {
    this.engine = props.engine
    this.port = props.port
    this.selfPid = props.selfPid ?? process.pid
    this.onLog = props.onLog
    this.mcpTokenForProject = props.mcpTokenForProject
  }

  start(): Server<undefined> {
    if (this.server) return this.server

    const app = buildGatewayApp({
      selfPid: this.selfPid,
      engine: this.engine,
      mcpTokenForProject: this.mcpTokenForProject,
    })

    // Bind to loopback only. The MCP route is bearer-protected, but `/status`,
    // `/health`, and `/threads` are not — exposing them on every interface
    // would leak pid + thread ids to anyone on the LAN.
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      development: false,
      fetch: (request) => app.fetch(request),
    })

    if (this.onLog) {
      this.onLog(`[leuco] gateway listening on http://127.0.0.1:${this.port}`)
    }

    return this.server
  }

  /**
   * Gracefully drain the server before resolving. `Bun.Server.stop()` returns
   * a Promise that settles once existing requests finish; awaiting it lets
   * in-flight MCP tool calls complete before the engine tears down their
   * backing tenants.
   */
  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    await server.stop()
  }
}
