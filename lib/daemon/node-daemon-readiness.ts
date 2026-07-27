import { z } from "zod"
import { DaemonReadinessPort, type GatewayProbeProps } from "@/daemon/daemon-readiness-port"

const healthSchema = z
  .object({
    ok: z.literal(true),
    pid: z.number().int().positive(),
  })
  .passthrough()

export class NodeDaemonReadiness extends DaemonReadinessPort {
  async getHealthyPid(props: GatewayProbeProps): Promise<number | null> {
    try {
      const response = await fetch(`http://127.0.0.1:${props.port}/health`, {
        signal: AbortSignal.timeout(props.timeoutMs),
      })
      if (!response.ok) return null

      const parsed = healthSchema.safeParse(await response.json())
      return parsed.success ? parsed.data.pid : null
    } catch {
      return null
    }
  }

  now(): number {
    return Date.now()
  }

  sleep(durationMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, durationMs))
  }
}
