import { validateDiscordCommand } from "@/cli/validate-discord-command"
import { MAX_FILE_TRANSFER_BYTES } from "@/file-transfer-limits"
import { createLiteralRecordSchema } from "@/config/create-literal-record-schema"
import { MAX_THREAD_KEY_CHARACTERS, MAX_TURN_INPUT_BYTES } from "@/turn-input-limits"
import { readControlMultipart } from "@/daemon/read-control-multipart"
import { CliError } from "@/cli/cli-error"
import { daemonRejectionResponse } from "@/daemon/daemon-rejection-response"
import type { LeucoEventQuery } from "@/events/leuco-event-query"
import { daemonErrorResponse } from "@/daemon/daemon-error-response"
import { launchSchema } from "@/maintenance/maintenance-schema"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { validateSlackCommand } from "@/cli/validate-slack-command"
import type { CliArguments } from "@/cli/parse-arguments"
import type { SlackCommandOptions } from "@/runtime/slack-command-options"
import { readControlJson } from "@/daemon/read-control-json"
import { parseMultipartCommand } from "@/daemon/parse-multipart-command"
import { parseControlInput } from "@/daemon/parse-control-input"

const decimalIntegerSchema = z
  .string()
  .regex(/^[0-9]+$/)
  .transform(Number)
  .pipe(z.number().int())

const turnSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .max(
      MAX_THREAD_KEY_CHARACTERS,
      `Thread key must not exceed ${MAX_THREAD_KEY_CHARACTERS} UTF-16 code units`,
    )
    .default("cli"),
  text: z
    .string()
    .min(1)
    .regex(/\S/, "Turn input must contain non-whitespace text")
    .refine(
      (text) => Buffer.byteLength(text, "utf8") <= MAX_TURN_INPUT_BYTES,
      `Turn input exceeds ${MAX_TURN_INPUT_BYTES} UTF-8 bytes; reduce the input`,
    ),
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
  runDiscordCommand?: (parsed: CliArguments, requestId: string) => Promise<unknown>
  runSlackCommand?: (parsed: CliArguments, options?: SlackCommandOptions) => Promise<unknown>
  stop: (requestId: string) => void
  awaitStop?: () => Promise<void>
  ownsProcess?: boolean
}

export function handleDaemonRequest(props: Props): (request: Request) => Promise<Response> {
  return async (request) => {
    const requestId = z.uuid().safeParse(request.headers.get("x-leuco-request-id")).success
      ? request.headers.get("x-leuco-request-id")!
      : randomUUID()
    if (request.headers.get("authorization") !== `Bearer ${props.token}`)
      return daemonRejectionResponse({
        status: 401,
        phase: "authorization",
        message: "Unauthorized",
        requestId,
      })
    const url = new URL(request.url)
    const path = url.pathname
    try {
      if (path !== "/events" && url.searchParams.size > 0)
        throw new CliError("USAGE", "This control endpoint does not accept query parameters", {
          phase: "validation",
          executionStarted: false,
        })
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
        const query = url.searchParams
        const filters = parseControlInput(
          z.strictObject({
            limit: decimalIntegerSchema.pipe(z.number().min(1).max(10000)).default(100),
            sinceTs: decimalIntegerSchema.pipe(z.number().nonnegative()).optional(),
            type: z.string().min(1).optional(),
            requestId: z.string().min(1).optional(),
            summary: z
              .enum(["true", "false"])
              .transform((value) => value === "true")
              .optional(),
          }),
          Object.fromEntries(
            Array.from(query.keys(), (key) => {
              const values = query.getAll(key)
              return [key, values.length === 1 ? values[0] : values]
            }),
          ),
          [props.token],
        )
        if (!props.getVolatileEvents) throw new Error("Volatile history is unavailable")
        return Response.json(props.getVolatileEvents(filters))
      }
      if (request.method === "POST" && path === "/restart") {
        if (props.restart === undefined)
          return daemonRejectionResponse({
            status: 503,
            phase: "availability",
            message: "Restart is unavailable",
            requestId,
          })
        try {
          const overrides = parseControlInput(
            launchSchema.pick({ cwd: true, soul: true }),
            await readControlJson(request),
            [props.token],
          )
          return Response.json(props.restart(overrides, requestId))
        } catch (error) {
          return daemonErrorResponse({
            error,
            status: 422,
            requestId,
            reportError: props.reportError,
            redactionSecrets: [props.token],
          })
        }
      }
      if (request.method === "POST" && path === "/stop") {
        const input = request.body === null ? {} : await readControlJson(request)
        parseControlInput(z.strictObject({}), input, [props.token])
        props.stop(requestId)
        if (props.awaitStop) await props.awaitStop()
        return Response.json({
          stopping: true,
          stopped: props.awaitStop !== undefined,
          processWillExit: props.ownsProcess ?? false,
        })
      }
      if (request.method === "POST" && path === "/discord") {
        if (!props.isReady())
          return daemonRejectionResponse({
            status: 503,
            phase: "readiness",
            message: "Leuco is starting or stopping",
            requestId,
          })
        try {
          const parsed = parseControlInput(
            z.strictObject({
              words: z.array(z.string()),
              flags: createLiteralRecordSchema(z.union([z.string(), z.literal(true)])),
            }),
            await readControlJson(request),
            [props.token],
          )
          validateDiscordCommand(parsed)
          if (parsed.words[0] !== "discord" || parsed.words[1] !== "call")
            throw new Error("Unsupported Discord operation")
          if (props.runDiscordCommand === undefined) throw new Error("Discord is unavailable")
          return Response.json(await props.runDiscordCommand(parsed, requestId))
        } catch (error) {
          return daemonErrorResponse({
            error,
            status: 422,
            requestId,
            reportError: props.reportError,
            redactionSecrets: [props.token],
            fallback: "Discord operation failed. Inspect events for this requestId.",
          })
        }
      }
      if (request.method === "POST" && path === "/slack") {
        if (!props.isReady())
          return daemonRejectionResponse({
            status: 503,
            phase: "readiness",
            message: "Leuco is starting or stopping",
            requestId,
          })
        try {
          const multipart = request.headers.get("content-type")?.startsWith("multipart/form-data")
            ? await readControlMultipart(request)
            : null
          const raw: unknown =
            multipart === null ? await readControlJson(request) : parseMultipartCommand(multipart)
          const parsed = parseControlInput(
            z.strictObject({
              words: z.array(z.string()),
              flags: createLiteralRecordSchema(z.union([z.string(), z.literal(true)])),
            }),
            raw,
            [props.token],
          )
          validateSlackCommand(parsed)
          if (multipart !== null && parsed.words[1] !== "upload-file")
            throw new CliError("USAGE", "Multipart input is only supported for Slack uploads", {
              phase: "validation",
              executionStarted: false,
            })
          if (props.runSlackCommand === undefined) throw new Error("Slack is unavailable")
          const file = multipart?.get("file")
          if (parsed.words[1] === "upload-file" && !(file instanceof Blob))
            throw new CliError("USAGE", "Slack uploads require a multipart file body", {
              phase: "validation",
              executionStarted: false,
            })
          if (file instanceof Blob && file.size > MAX_FILE_TRANSFER_BYTES)
            throw new Error("Upload exceeds 100 MiB")
          const upload = file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : undefined
          const reply = await props.runSlackCommand(parsed, {
            upload,
            requestId,
            signal: request.signal,
          })
          return reply instanceof Response ? reply : Response.json(reply)
        } catch (error) {
          return daemonErrorResponse({
            error,
            status: 422,
            requestId,
            reportError: props.reportError,
            redactionSecrets: [props.token],
            fallback: "Slack operation failed. Inspect events for this requestId.",
          })
        }
      }
      if (request.method !== "POST" || path !== "/turn")
        return Response.json({ error: "Not found" }, { status: 404 })
      if (!props.isReady())
        return daemonRejectionResponse({
          status: 503,
          phase: "readiness",
          message: "Leuco is starting or stopping",
          requestId,
        })
      try {
        const turn = parseControlInput(turnSchema, await readControlJson(request), [props.token])
        const reply = await props.runTextTurn(turn.key, turn.text, requestId)
        if (reply instanceof Error)
          return daemonErrorResponse({
            error: reply,
            status: 422,
            requestId,
            reportError: props.reportError,
            redactionSecrets: [props.token],
          })
        return Response.json({ reply })
      } catch (error) {
        return daemonErrorResponse({
          error,
          status: 400,
          requestId,
          reportError: props.reportError,
          redactionSecrets: [props.token],
        })
      }
    } catch (error) {
      return daemonErrorResponse({
        error,
        status: error instanceof CliError && error.code === "USAGE" ? 400 : 500,
        requestId,
        reportError: props.reportError,
        redactionSecrets: [props.token],
      })
    }
  }
}
