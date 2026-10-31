import { errorFromDetails } from "@/error-from-details"
import { daemonFailureResponseSchema } from "@/daemon/daemon-failure-schema"
import { copyRedactedError } from "@/secrets/copy-redacted-error"
import { redactJsonSecrets } from "@/secrets/redact-json-secrets"
import { join } from "node:path"
import type { DaemonLease } from "@/daemon/daemon-lease"
import { readDaemonLease } from "@/daemon/daemon-lease"
import { hasPossibleMutation } from "@/cli/has-possible-mutation"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { errorMessage } from "@/error-message"
import { awaitAbortableOperation } from "@/await-abortable-operation"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { readBoundedJsonResponse } from "@/read-bounded-json-response"
import { verifyDaemonStatus } from "@/daemon/verify-daemon-status"
import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"

export type DaemonRequest = {
  home: string
  path: string
  body?: unknown
  timeoutMs?: number
  requestId?: string
  expectedLease?: DaemonLease
  signal?: AbortSignal
}

/** One deadline covers headers and JSON; streaming callers take ownership of successful bodies. */
export class DaemonHttpRequest {
  private readonly startedTick = performance.now()
  private readonly props: DaemonRequest
  private readonly signal: AbortSignal
  private readonly state: { started: boolean; lease: DaemonLease | null } = {
    started: false,
    lease: null,
  }

  constructor(props: DaemonRequest) {
    const input = { ...props }
    this.props = {
      ...input,
      ...(input.expectedLease
        ? { expectedLease: { pid: input.expectedLease.pid, token: input.expectedLease.token } }
        : {}),
    }
    this.signal = this.props.signal
      ? this.props.timeoutMs === undefined
        ? this.props.signal
        : AbortSignal.any([this.props.signal, AbortSignal.timeout(this.props.timeoutMs)])
      : AbortSignal.timeout(this.props.timeoutMs ?? 5000)
    Object.freeze(this)
  }

  async getJson(): Promise<unknown> {
    const response = await this.getResponse()
    const value = await this.readJsonBody(response, 16 * 1024 * 1024).catch((error: unknown) => {
      const cause = this.redactFailure(error)
      const diagnostic = this.requestDiagnostics()
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Cannot verify daemon JSON result (${diagnostic.summary}): ${errorMessage(cause)}`,
        {
          status: response.status,
          phase: "body",
          request: diagnostic.context,
          causes: errorDetails(cause),
        },
      )
      failure.cause = cause
      throw failure
    })
    if (this.props.path !== "/status") return value
    const expected = this.state.lease
    if (expected === null) throw new Error("Daemon status has no ownership context")
    try {
      return verifyDaemonStatus(value, expected, readDaemonLease(this.props.home))
    } catch (error) {
      if (error instanceof CliError) throw error
      const cause = this.redactFailure(error)
      const failure = new CliError(
        "STATE_UNCERTAIN",
        "Cannot verify daemon ownership after the status response; inspect before acting",
        {
          phase: "identity",
          causes: errorDetails(cause),
        },
      )
      failure.cause = cause
      throw failure
    }
  }

  async getResponse(): Promise<Response> {
    const response = await this.open()
    if (response.ok) return response
    const code =
      response.status === 401 || response.status === 503 ? "STATE_UNCERTAIN" : "OPERATION_FAILED"
    const payload = await this.readJsonBody(response, 1024 * 1024).catch((error: unknown) => {
      const cause = this.redactFailure(error)
      const diagnostic = this.requestDiagnostics()
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Daemon returned HTTP ${response.status}; error body could not be read (${diagnostic.summary}): ${errorMessage(cause)}`,
        {
          status: response.status,
          phase: "error-body",
          request: diagnostic.context,
          causes: errorDetails(cause),
        },
      )
      failure.cause = cause
      throw failure
    })
    const forwarded = daemonFailureResponseSchema.safeParse(payload)
    if (forwarded.success) {
      const remote = forwarded.data
      if (this.props.requestId !== undefined && remote.requestId !== this.props.requestId)
        throw new CliError(
          "STATE_UNCERTAIN",
          "Daemon error response has a different requestId; inspect before acting",
          {
            phase: "error-identity",
            status: response.status,
            expectedRequestId: this.props.requestId,
            actualRequestId: remote.requestId,
          },
        )
      const details = remote.failure.details
      const structured =
        typeof details === "object" && details !== null && !Array.isArray(details)
          ? details
          : { originalDetails: details }
      const failure = new CliError(remote.failure.code, remote.error, {
        ...structured,
        ...(Object.hasOwn(structured, "causes") ? {} : { causes: remote.failure.causes }),
        mutationMayHaveOccurred:
          !("executionStarted" in structured && structured.executionStarted === false) ||
          hasPossibleMutation(structured),
      })
      if (remote.failure.causes.length > 0) failure.cause = errorFromDetails(remote.failure.causes)
      throw failure
    }
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? errorMessage(payload.error)
        : `Daemon returned HTTP ${response.status}`
    throw new CliError(code, message, {
      daemon: payload,
      status: response.status,
      ...(code === "STATE_UNCERTAIN" ? { phase: "error-classification" } : {}),
    })
  }

  private async open(): Promise<Response> {
    if (this.state.started) throw new Error("A daemon request can only run once")
    this.state.started = true
    this.signal.throwIfAborted()
    const lease = readDaemonLease(this.props.home)
    if (lease === null) throw new CliError("NOT_RUNNING", "Leuco is not running; run leuco start")
    if (
      this.props.expectedLease &&
      (lease.token !== this.props.expectedLease.token || lease.pid !== this.props.expectedLease.pid)
    )
      throw new CliError(
        "STATE_CONFLICT",
        "Daemon identity changed before the request; refusing to control another instance",
      )
    const multipart = this.props.body instanceof FormData
    this.state.lease = lease
    const body =
      this.props.body === undefined
        ? undefined
        : this.props.body instanceof FormData
          ? this.props.body
          : JSON.stringify(this.props.body)
    try {
      return await awaitAbortableOperation(
        fetch(`http://localhost${this.props.path}`, {
          unix: join(this.props.home, "control.sock"),
          method: this.props.body === undefined ? "GET" : "POST",
          headers: {
            authorization: `Bearer ${lease.token}`,
            ...(this.props.requestId ? { "x-leuco-request-id": this.props.requestId } : {}),
            ...(multipart ? {} : { "content-type": "application/json" }),
          },
          ...(this.props.body === undefined ? {} : { body }),
          signal: this.signal,
        }),
        this.signal,
      )
    } catch (error) {
      const cause = this.redactFailure(error)
      const diagnostic = this.requestDiagnostics()
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Cannot observe daemon response (${diagnostic.summary}). Inspect status, logs and operation history before retrying.`,
        { phase: "transport", request: diagnostic.context, transport: errorDetails(cause) },
      )
      failure.cause = cause
      throw failure
    }
  }

  private redactFailure(error: unknown): Error {
    return copyRedactedError(error, this.state.lease ? [this.state.lease.token] : [])
  }

  private requestDiagnostics() {
    const context = {
      method: this.props.body === undefined ? "GET" : "POST",
      path: truncateDiagnosticText(
        redactPublicText(
          this.props.path.split(/[?#]/, 1)[0] || "/",
          this.state.lease ? [this.state.lease.token] : [],
        ),
        256,
      ),
      leasePid: this.state.lease?.pid ?? null,
      timeoutMs: this.props.timeoutMs ?? (this.props.signal ? null : 5000),
      elapsedMs: Math.max(0, Math.round(performance.now() - this.startedTick)),
      aborted: this.signal.aborted,
      callerAborted: this.props.signal?.aborted ?? false,
    }
    return {
      context,
      summary: `${context.method} ${context.path}; budget=${context.timeoutMs === null ? "caller signal" : `${context.timeoutMs}ms`}; elapsed=${context.elapsedMs}ms`,
    }
  }

  private async readJsonBody(response: Response, maxBytes: number): Promise<unknown> {
    try {
      const value = await readBoundedJsonResponse({
        response,
        maxBytes,
        signal: this.signal,
        label: response.ok ? "Daemon JSON response" : `Daemon HTTP ${response.status} error body`,
        limitHint: response.ok
          ? "reduce the requested history limit when inspecting large event results"
          : undefined,
      })
      return redactJsonSecrets(value, this.state.lease ? [this.state.lease.token] : [])
    } catch (error) {
      const primary = this.signal.aborted ? this.signal.reason : error
      const failures: unknown[] = [primary]
      if (error !== primary) failures.push(error)
      try {
        await awaitBoundedCleanup(
          Promise.resolve().then(async () => {
            await response.body?.cancel(primary)
          }),
          "Daemon response cancellation",
        )
      } catch (cleanup) {
        failures.push(cleanup)
      }
      const unique = [...new Set(failures)]
      if (unique.length === 1) throw primary
      throw new AggregateError(
        unique,
        `${errorMessage(primary)}; additional response or cleanup failure`,
        { cause: primary },
      )
    }
  }
}
