import { MAX_FILE_TRANSFER_BYTES } from "@/file-transfer-limits"
import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import { requiredCliFlag } from "@/cli/required-cli-flag"
import { readBoundedUploadFile } from "@/actions/slack/read-bounded-upload-file"
import { downloadResponseToFile } from "@/fs/download-response-to-file"
import { requestDaemon } from "@/daemon/request-daemon"
import { DaemonHttpRequest } from "@/daemon/daemon-http-request"
import { DEFAULT_CLI_TIMEOUT_MS } from "@/cli/command-catalog"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { readDiagnosticProperty } from "@/read-diagnostic-property"

// Path errors from opening the caller's file; read and close failures keep their original class.
const UNUSABLE_UPLOAD_PATH_CODES = [
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "EACCES",
  "EPERM",
  "ENXIO",
]

function rejectUploadFile(reason: string, cause?: unknown): CliError {
  const failure = new CliError(
    "USAGE",
    `${reason}; --file must be a caller-readable regular file of at most 100 MiB`,
    {
      phase: "validation",
      parameter: "file",
      executionStarted: false,
      ...(cause === undefined ? {} : { causes: errorDetails(cause) }),
    },
  )
  if (cause !== undefined) failure.cause = cause
  return failure
}

export async function requestSlackCommand(
  home: string,
  parsed: CliArguments,
  context: { signal?: AbortSignal; requestId: string },
): Promise<unknown> {
  const signal = context.signal
  const requestId = context.requestId
  const timeoutMs = Number(parsed.flags["timeout-ms"] ?? DEFAULT_CLI_TIMEOUT_MS)
  if (parsed.words[1] === "upload-file") {
    const file = await readBoundedUploadFile({
      path: resolve(requiredCliFlag(parsed, "file")),
      maxBytes: MAX_FILE_TRANSFER_BYTES,
    }).catch((error: unknown) => {
      const code = readDiagnosticProperty(error, "code", undefined)
      if (typeof code !== "string" || !UNUSABLE_UPLOAD_PATH_CODES.includes(code)) throw error
      throw rejectUploadFile(`Upload file could not be opened (${code})`, error)
    })
    if (!file.isFile) throw rejectUploadFile("Upload file is not a regular file")
    if (file.exceedsLimit) throw rejectUploadFile("Upload file exceeds 100 MiB")
    const multipart = new FormData()
    multipart.set("command", JSON.stringify(parsed))
    multipart.set("file", new Blob([new Uint8Array(file.content)]), "upload")
    return requestDaemon({
      home,
      path: "/slack",
      requestId,
      body: multipart,
      timeoutMs,
      signal,
    })
  }
  if (parsed.words[1] === "download-file")
    return downloadResponseToFile({
      outputPath: resolve(requiredCliFlag(parsed, "out")),
      signal,
      timeoutMs,
      fetchResponse: (downloadSignal) =>
        new DaemonHttpRequest({
          home,
          path: "/slack",
          requestId,
          body: parsed,
          signal: downloadSignal,
          timeoutMs,
        }).getResponse(),
    })
  return requestDaemon({
    home,
    path: "/slack",
    requestId,
    body: parsed,
    timeoutMs,
    signal,
  })
}
