import { MAX_FILE_TRANSFER_BYTES } from "@/file-transfer-limits"
import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import { requiredCliFlag } from "@/cli/required-cli-flag"
import { readBoundedUploadFile } from "@/actions/slack/read-bounded-upload-file"
import { downloadResponseToFile } from "@/fs/download-response-to-file"
import { requestDaemon } from "@/daemon/request-daemon"
import { requestDaemonResponse } from "@/daemon/request-daemon-response"
import { DEFAULT_CLI_TIMEOUT_MS } from "@/cli/command-catalog"

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
    })
    if (!file.isFile || file.exceedsLimit)
      throw new Error("Upload requires a regular file of at most 100 MiB")
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
        requestDaemonResponse({
          home,
          path: "/slack",
          requestId,
          body: parsed,
          signal: downloadSignal,
          timeoutMs,
        }),
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
