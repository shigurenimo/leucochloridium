import { z } from "zod"
import { DaemonReadinessPort, type GatewayProbeProps } from "@/daemon/daemon-readiness-port"
import { errorMessage } from "@/error-message"
import {
  requestNodeDaemonHealth,
  type NodeDaemonHealthResponse,
} from "@/daemon/request-node-daemon-health"

type Props = {
  requestHealth: (props: GatewayProbeProps) => Promise<NodeDaemonHealthResponse>
}

type Diagnostic = {
  message: string | null
}

const defaultProps: Props = {
  requestHealth: requestNodeDaemonHealth,
}

const healthSchema = z
  .object({
    ok: z.literal(true),
    pid: z.number().int().positive(),
  })
  .passthrough()

export class NodeDaemonReadiness extends DaemonReadinessPort {
  private readonly diagnostic: Diagnostic

  constructor(private readonly props: Props = defaultProps) {
    super()
    this.diagnostic = { message: null }
    Object.freeze(this)
  }

  async getHealthyPid(props: GatewayProbeProps): Promise<number | null> {
    try {
      const response = await this.props.requestHealth(props)
      if (response.statusCode < 200 || response.statusCode >= 300) {
        this.diagnostic.message = `HTTP ${response.statusCode}`
        return null
      }

      const parsed = healthSchema.safeParse(JSON.parse(response.bodyText))
      if (!parsed.success) {
        this.diagnostic.message = "invalid JSON response"
        return null
      }

      this.diagnostic.message = null
      return parsed.data.pid
    } catch (error) {
      this.diagnostic.message = errorMessage(error)
      return null
    }
  }

  getDiagnostic(): string | null {
    return this.diagnostic.message
  }

  now(): number {
    return Date.now()
  }

  sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs))
  }
}
