import { readBoundedJsonResponse } from "@/read-bounded-json-response"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { CliError } from "@/cli/cli-error"
import {
  MAX_CONTROL_JSON_BYTES,
  CONTROL_JSON_RECEIVE_TIMEOUT_MS,
} from "@/daemon/control-input-limits"

/** Uploads have their own multipart envelope; ordinary control JSON must remain small and finite. */
export async function readControlJson(request: Request): Promise<unknown> {
  const controller = new AbortController()
  const signal = AbortSignal.any([request.signal, controller.signal])
  const headers = new Headers()
  const declaredLength = request.headers.get("content-length")
  if (declaredLength !== null) headers.set("content-length", declaredLength)
  const response = new Response(request.body, { headers })
  const timer = setTimeout(
    () =>
      controller.abort(
        new Error(`Control JSON receive timed out after ${CONTROL_JSON_RECEIVE_TIMEOUT_MS}ms`),
      ),
    CONTROL_JSON_RECEIVE_TIMEOUT_MS,
  )
  try {
    return await readBoundedJsonResponse({
      response,
      signal,
      label: "Control JSON request",
      maxBytes: MAX_CONTROL_JSON_BYTES,
    })
  } catch (error) {
    clearTimeout(timer)
    const failure = new CliError(
      "USAGE",
      "Control JSON body was not accepted before execution; inspect causes for input or reception failures",
      { phase: "control-body", executionStarted: false },
    )
    failure.cause = error
    try {
      await awaitBoundedCleanup(
        Promise.resolve().then(async () => {
          await response.body?.cancel(error)
        }),
        "Control JSON body cancellation",
      )
    } catch (cleanup) {
      failure.cause = new AggregateError([error, cleanup], "Control JSON read and cleanup failed", {
        cause: error,
      })
    }
    throw failure
  } finally {
    clearTimeout(timer)
  }
}
