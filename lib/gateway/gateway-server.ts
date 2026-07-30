import type { Server } from "bun"
import type { DaemonControl } from "@/control/daemon-control"
import { buildGatewayApp } from "@/gateway/build-gateway-app"

export type LeucoGatewayServerProps = {
  control: DaemonControl
  port: number
  selfPid?: number
  onLog?: (line: string) => void
}

/**
 * In-process HTTP gateway: runs `Bun.serve` against the Hono app built by
 * `buildGatewayApp`. Started by the engine on every run for loopback daemon
 * health, status, and thread control.
 */
export class LeucoGatewayServer {
  private readonly control: DaemonControl
  private readonly port: number
  private readonly selfPid: number
  private readonly onLog: ((line: string) => void) | undefined
  private server: Server<undefined> | null = null

  constructor(props: LeucoGatewayServerProps) {
    this.control = props.control
    this.port = props.port
    this.selfPid = props.selfPid ?? process.pid
    this.onLog = props.onLog
  }

  start(): Server<undefined> {
    if (this.server) return this.server

    const app = buildGatewayApp({
      selfPid: this.selfPid,
      control: this.control,
    })

    // Bind to loopback only. Exposing these routes on every interface would
    // leak pid and thread ids to anyone on the LAN.
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
   * a Promise that settles once existing requests finish.
   */
  async stop(): Promise<void> {
    if (!this.server) return
    const server = this.server
    this.server = null
    await server.stop()
  }
}
