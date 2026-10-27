import { resolve } from "node:path"
import type { CliArguments } from "@/cli/parse-arguments"
import { required } from "@/cli/manage-settings"
import { readBoundedUploadFile } from "@/actions/slack/read-bounded-upload-file"
import { downloadResponseToFile } from "@/fs/download-response-to-file"
import { requestDaemon } from "@/daemon/request-daemon"
import { requestDaemonResponse } from "@/daemon/request-daemon-response"

export async function requestSlackCommand(home: string, parsed: CliArguments): Promise<unknown> {
  if (parsed.words[1] === "upload-file") {
    const file = await readBoundedUploadFile({
      path: resolve(required(parsed, "file")),
      maxBytes: 100 * 1024 * 1024,
    })
    if (!file.isFile || file.exceedsLimit)
      throw new Error("Upload requires a regular file of at most 100 MiB")
    const multipart = new FormData()
    multipart.set("command", JSON.stringify(parsed))
    multipart.set("file", new Blob([new Uint8Array(file.content)]), "upload")
    return requestDaemon(home, "/slack", multipart, null)
  }
  if (parsed.words[1] === "download-file")
    return downloadResponseToFile({
      outputPath: resolve(required(parsed, "out")),
      fetchResponse: (signal) =>
        requestDaemonResponse({ home, path: "/slack", body: parsed, signal }),
    })
  return requestDaemon(home, "/slack", parsed, null)
}
