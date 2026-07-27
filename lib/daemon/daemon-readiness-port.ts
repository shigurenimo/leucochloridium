export type GatewayProbeProps = {
  port: number
  timeoutMs: number
}

export abstract class DaemonReadinessPort {
  abstract getHealthyPid(props: GatewayProbeProps): Promise<number | null>

  abstract now(): number

  abstract sleep(durationMs: number): Promise<void>
}
