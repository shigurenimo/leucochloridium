import type { LeucoEventQuery } from "@/events/leuco-event-query"
import { daemonErrorResponse } from "@/daemon/daemon-error-response"
import { launchSchema } from "@/maintenance/maintenance-schema"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { validateCommand } from "@/cli/validate-command"
import type { CliArguments } from "@/cli/parse-arguments"

const turnSchema = z.object({
  key: z.string().min(1).max(512).default("cli"),
  text: z
    .string()
    .min(1)
    .max(256 * 1024),
})
type Props = {
  token: string
  getVolatileEvents?: (query: LeucoEventQuery) => unknown
  reportError?: (error: unknown, requestId: string) => string
  cwd: string
  getMaintenance?: () => unknown
  restart?: (overrides: Partial<LaunchConfiguration>, requestId: string) => unknown
  getRuntimeStatus?: () => unknown
  isReady: () => boolean
  runTextTurn: (key: string, text: string, requestId?: string) => Promise<string | Error>
  runSlackCommand?: (
    parsed: CliArguments,
    upload?: Uint8Array,
    requestId?: string,
  ) => Promise<unknown>
  stop: (requestId: string) => void
  awaitStop?: () => Promise<void>
  ownsProcess?: boolean
}

export function handleDaemonRequest(props: Props): (request: Request) => Promise<Response> {
  return async (request) => {
    if (request.headers.get("authorization") !== `Bearer ${props.token}`)
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    const path = new URL(request.url).pathname
    const requestId = z.uuid().safeParse(request.headers.get("x-leuco-request-id")).success
      ? request.headers.get("x-leuco-request-id")!
      : randomUUID()
    if (request.method === "GET" && path === "/status")
      return Response.json({
        running: true,
        ready: props.isReady(),
        pid: process.pid,
        cwd: props.cwd,
        ...(props.getMaintenance ? { maintenance: props.getMaintenance() } : {}),
        ...(props.getRuntimeStatus ? { runtime: props.getRuntimeStatus() } : {}),
      })
    if (request.method === "GET" && path === "/events") {
      const query = new URL(request.url).searchParams
      const filters = z
        .object({
          limit: z.coerce.number().int().min(1).max(10000).default(100),
          sinceTs: z.coerce.number().nonnegative().optional(),
          type: z.string().optional(),
          requestId: z.string().max(512).optional(),
        })
        .parse(Object.fromEntries(query))
      if (!props.getVolatileEvents) throw new Error("Volatile history is unavailable")
      return Response.json(props.getVolatileEvents(filters))
    }
    if (request.method === "POST" && path === "/restart") {
      if (props.restart === undefined)
        return Response.json({ error: "Restart is unavailable" }, { status: 503 })
      try {
        const overrides = launchSchema
          .pick({ cwd: true, soul: true, model: true, codexBin: true })
          .parse(await request.json())
        return Response.json(props.restart(overrides, requestId))
      } catch (error) {
        return daemonErrorResponse({
          error,
          status: 422,
          requestId,
          reportError: props.reportError,
        })
      }
    }
    if (request.method === "POST" && path === "/stop") {
      props.stop(requestId)
      if (props.awaitStop) await props.awaitStop()
      return Response.json({
        stopping: true,
        stopped: props.awaitStop !== undefined,
        processWillExit: props.ownsProcess ?? false,
      })
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
        const reply = await props.runSlackCommand(parsed, upload, requestId)
        return reply instanceof Response ? reply : Response.json(reply)
      } catch (error) {
        return daemonErrorResponse({
          error,
          status: 422,
          requestId,
          reportError: props.reportError,
          fallback: "Slack operation failed. Inspect events for this requestId.",
        })
      }
    }
    if (request.method !== "POST" || path !== "/turn")
      return Response.json({ error: "Not found" }, { status: 404 })
    if (!props.isReady())
      return Response.json({ error: "Leuco is starting or stopping" }, { status: 503 })
    try {
      const turn = turnSchema.parse(await request.json())
      const reply = await props.runTextTurn(turn.key, turn.text, requestId)
      if (reply instanceof Error)
        return daemonErrorResponse({
          error: reply,
          status: 422,
          requestId,
          reportError: props.reportError,
        })
      return Response.json({ reply })
    } catch (error) {
      return daemonErrorResponse({ error, status: 400, requestId, reportError: props.reportError })
    }
  }
}
