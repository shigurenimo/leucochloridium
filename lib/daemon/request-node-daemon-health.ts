import { request } from "node:http"
import type { GatewayProbeProps } from "@/daemon/daemon-readiness-port"

export type NodeDaemonHealthResponse = {
  statusCode: number
  bodyText: string
}

const MAX_HEALTH_BODY_BYTES = 16 * 1024

export const requestNodeDaemonHealth = (
  props: GatewayProbeProps,
): Promise<NodeDaemonHealthResponse> =>
  new Promise((resolve, reject) => {
    const healthRequest = request(
      {
        hostname: "127.0.0.1",
        port: props.port,
        path: "/health",
        method: "GET",
        headers: {
          accept: "application/json",
          connection: "close",
        },
      },
      (response) => {
        const chunks: Buffer[] = []

        response.on("data", (chunk: unknown) => {
          const bytes =
            typeof chunk === "string" ? Buffer.from(chunk) : Buffer.isBuffer(chunk) ? chunk : null
          if (bytes === null) {
            response.destroy(new Error("health response returned an unsupported body chunk"))
            return
          }

          chunks.push(bytes)
          if (Buffer.concat(chunks).byteLength > MAX_HEALTH_BODY_BYTES) {
            response.destroy(new Error("health response exceeded 16 KiB"))
          }
        })
        response.once("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        response.once("end", () => {
          clearTimeout(timeout)
          resolve({
            statusCode: response.statusCode ?? 0,
            bodyText: Buffer.concat(chunks).toString("utf8"),
          })
        })
      },
    )

    const timeout = setTimeout(() => {
      const error = new Error(`health request timed out after ${props.timeoutMs}ms`)
      reject(error)
      healthRequest.destroy(error)
    }, props.timeoutMs)

    healthRequest.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    healthRequest.end()
  })
