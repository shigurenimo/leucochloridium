import { DaemonReadinessPort, type GatewayProbeProps } from "@/daemon/daemon-readiness-port"

type ProbeReply = number | null | Error

type Props = {
  replies?: ReadonlyArray<ProbeReply>
  onSleep?: (durationMs: number, readiness: MemoryDaemonReadiness) => void
}

export class MemoryDaemonReadiness extends DaemonReadinessPort {
  readonly probes: GatewayProbeProps[] = []
  readonly sleeps: number[] = []
  private readonly replies: ProbeReply[]
  private clockMs = 0
  private diagnostic: string | null = null

  constructor(private readonly props: Props = {}) {
    super()
    this.replies = [...(props.replies ?? [])]
  }

  async getHealthyPid(props: GatewayProbeProps): Promise<number | null> {
    this.probes.push(props)
    const reply = this.replies.shift() ?? null
    if (reply instanceof Error) {
      this.diagnostic = reply.message
      throw reply
    }
    this.diagnostic = null
    return reply
  }

  getDiagnostic(): string | null {
    return this.diagnostic
  }

  now(): number {
    return this.clockMs
  }

  async sleep(durationMs: number): Promise<void> {
    this.sleeps.push(durationMs)
    this.clockMs += durationMs
    this.props.onSleep?.(durationMs, this)
  }
}
