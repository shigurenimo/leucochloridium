import { z } from "zod"

type Props = {
  botToken: string
  method: string
  endpoint: string
  body?: Record<string, unknown>
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}

/** 固定したDiscord APIだけに資格情報を送り、書き込みは自動再送しない。 */
export async function discordCall(props: Props): Promise<unknown> {
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(props.method))
    throw new Error("Invalid Discord HTTP method")
  if (
    !/^\/[A-Za-z0-9_%@/:-]+(?:\?[^#\s]*)?$/.test(props.endpoint) ||
    props.endpoint.startsWith("//")
  )
    throw new Error("Discord endpoint must be an API-relative path without traversal")
  const decoded = decodeURIComponent(props.endpoint.split("?")[0] ?? "")
  if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === ".."))
    throw new Error("Discord endpoint traversal is not allowed")
  const response = await (props.fetchFn ?? fetch)(`https://discord.com/api/v10${props.endpoint}`, {
    method: props.method,
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bot ${props.botToken}`, "content-type": "application/json" },
    body: props.body === undefined ? undefined : JSON.stringify(props.body),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(
      `Discord API failed (HTTP ${response.status}); do not automatically retry writes`,
    )
  }
  if (response.status === 204) return { ok: true }
  return z.json().parse(await response.json())
}
