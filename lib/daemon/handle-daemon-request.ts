import { z } from "zod"
import { validateCommand } from "@/cli/validate-command"
import type { CliArguments } from "@/cli/parse-arguments"
import { errorMessage } from "@/error-message"

const turnSchema = z.object({
  key: z.string().min(1).max(512).default("cli"),
  text: z
    .string()
    .min(1)
    .max(256 * 1024),
})
type Props = {
  token: string
  cwd: string
  isReady: () => boolean
  runTextTurn: (key: string, text: string) => Promise<string | Error>
  runSlackCommand?: (parsed: CliArguments, upload?: Uint8Array) => Promise<unknown>
  stop: () => void
}

export function handleDaemonRequest(props: Props): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${props.token}`)
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    const path = new URL(request.url).pathname
    if (request.method === "GET" && path === "/status")
      return Response.json({
        running: true,
        ready: props.isReady(),
        pid: process.pid,
        cwd: props.cwd,
      })
    if (request.method === "POST" && path === "/stop") {
      props.stop()
      return Response.json({ stopping: true })
    }
    if (request.method === "POST" && path === "/slack") {
      if (!props.isReady())
        return Response.json({ error: "Leuco is starting or stopping" }, { status: 503 })
      try {
        const multipart = request.headers.get("content-type")?.startsWith("multipart/form-data")
          ? await request.formData()
          : null
        const raw: unknown =
          multipart === null ? await request.json() : JSON.parse(String(multipart.get("command")))
        const parsed = z
          .strictObject({
            words: z.array(z.string()),
            flags: z.record(z.string(), z.union([z.string(), z.literal(true)])),
          })
          .parse(raw)
        const file = multipart?.get("file")
        if (file instanceof Blob && file.size > 100 * 1024 * 1024)
          throw new Error("Upload exceeds 100 MiB")
        const upload = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : undefined
        validateCommand(parsed)
        if (
          parsed.words[0] !== "slack" ||
          !["call", "upload-file", "download-file"].includes(parsed.words[1] ?? "")
        )
          throw new Error("Unsupported Slack operation")
        if (props.runSlackCommand === undefined) throw new Error("Slack is unavailable")
        const reply = await props.runSlackCommand(parsed, upload)
        return reply instanceof Response ? reply : Response.json(reply)
      } catch {
        return Response.json(
          { error: "Slack operation failed. Check the operation and daemon configuration." },
          { status: 422 },
        )
      }
    }
    if (request.method !== "POST" || path !== "/turn")
      return Response.json({ error: "Not found" }, { status: 404 })
    if (!props.isReady())
      return Response.json({ error: "Leuco is starting or stopping" }, { status: 503 })
    try {
      const turn = turnSchema.parse(await request.json())
      const reply = await props.runTextTurn(turn.key, turn.text)
      if (reply instanceof Error) return Response.json({ error: reply.message }, { status: 422 })
      return Response.json({ reply })
    } catch (error) {
      return Response.json({ error: errorMessage(error) }, { status: 400 })
    }
  }
}
