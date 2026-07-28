import { DEFAULT_LEUCO_PORT, cliEnvSchema } from "@/env/cli-env-schema"

type Props = {
  port?: number
  fetchFn?: typeof fetch
}

export class DaemonControlClient {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch

  constructor(props: Props = {}) {
    const parsed = cliEnvSchema.safeParse(process.env)
    const port = props.port ?? (parsed.success ? parsed.data.LEUCO_PORT : DEFAULT_LEUCO_PORT)

    this.baseUrl = `http://127.0.0.1:${port}`
    this.fetchFn = props.fetchFn ?? fetch
    Object.freeze(this)
  }

  reload(): Promise<boolean> {
    return this.post("/control/reload")
  }

  restartProject(projectId: string): Promise<boolean> {
    return this.post(`/projects/${encodeURIComponent(projectId)}/restart`)
  }

  restartConnector(projectId: string, connectorName: string): Promise<boolean> {
    return this.post(
      `/projects/${encodeURIComponent(projectId)}/connectors/${encodeURIComponent(connectorName)}/restart`,
    )
  }

  resetProjectSession(projectId: string): Promise<boolean> {
    return this.post(`/projects/${encodeURIComponent(projectId)}/session/reset`)
  }

  pauseProject(projectId: string): Promise<boolean> {
    return this.post(`/projects/${encodeURIComponent(projectId)}/pause`)
  }

  resumeProject(projectId: string): Promise<boolean> {
    return this.post(`/projects/${encodeURIComponent(projectId)}/resume`)
  }

  private async post(path: string): Promise<boolean> {
    let response: Response
    try {
      response = await this.fetchFn(`${this.baseUrl}${path}`, {
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      return false
    }

    if (response.ok) return true

    const message = (await response.text()).replace(/^error:\s*/, "")
    throw new Error(message || `daemon control failed with HTTP ${response.status}`)
  }
}
