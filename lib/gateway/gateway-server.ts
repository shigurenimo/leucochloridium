import type { Server } from "bun"
import { buildGatewayApp } from "@/gateway/build-gateway-app"
import type { LeucoEngine } from "@/engine/engine"

type Props = {
  engine: LeucoEngine
  port: number
  selfPid?: number
  onLog?: (line: string) => void
  mcpToken?: string | null
}

/**
 * In-process HTTP gateway: runs `Bun.serve` against the Hono app built by
 * `buildGatewayApp`. Started by the engine on every run — the MCP route at
 * `/mcp/:project/:agent` depends on it.
 */
export class LeucoGatewayServer {
  private readonly engine: LeucoEngine
  private readonly port: number
  private readonly selfPid: number
  private readonly onLog: ((line: string) => void) | undefined
  private readonly mcpToken: string | null
  private server: Server | null = null

  constructor(props: Props) {
    this.engine = props.engine
    this.port = props.port
    this.selfPid = props.selfPid ?? process.pid
    this.onLog = props.onLog
    this.mcpToken = props.mcpToken ?? null
  }

  start(): Server {
    if (this.server) return this.server

    const app = buildGatewayApp({
      selfPid: this.selfPid,
      engine: this.engine,
      mcpToken: this.mcpToken,
    })

    this.server = Bun.serve({
      port: this.port,
      development: false,
      fetch: (request) => app.fetch(request),
    })

    if (this.onLog) {
      this.onLog(`[leuco] gateway listening on http://localhost:${this.port}`)
    }

    return this.server
  }

  stop(): void {
    if (this.server) {
      this.server.stop()
      this.server = null
    }
  }
}
