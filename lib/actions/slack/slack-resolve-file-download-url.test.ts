import { afterEach, expect, it, vi } from "vitest"
import { slackResolveFileDownloadUrl } from "@/actions/slack/slack-resolve-file-download-url"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

afterEach(() => vi.restoreAllMocks())

it.each([
  { ok: true },
  { ok: true, file: {} },
  { ok: true, file: { url_private_download: "not a url" } },
])("preserves validation details for invalid file metadata: %j", async (response) => {
  const call = vi.spyOn(LeucoFetchSlackWebClient.prototype, "apiCall").mockResolvedValue(response)
  const failure = await slackResolveFileDownloadUrl({
    botToken: "synthetic",
    fileId: "F123",
  }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    message: "files.info response did not include url_private_download",
    cause: {
      name: "ZodError",
      issues: [expect.objectContaining({ path: expect.arrayContaining(["file"]) })],
    },
  })
  expect(call).toHaveBeenCalledExactlyOnceWith("files.info", { file: "F123" })
})
