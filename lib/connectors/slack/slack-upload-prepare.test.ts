import { expect, it, vi } from "vitest"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

it.each([
  { file_id: "" },
  { file_id: "   " },
  { upload_url: "" },
  { upload_url: "not a url" },
  { upload_url: "http://files.slack.com/upload/test" },
  { upload_url: "ftp://files.slack.com/upload/test" },
])("rejects invalid upload preparation before sending bytes: %j", async (invalid) => {
  const fetch = vi.fn(async () =>
    Response.json({
      ok: true,
      file_id: "F123",
      upload_url: "https://files.slack.com/upload/test",
      ...invalid,
    }),
  )
  const client = new LeucoFetchSlackWebClient({ botToken: "synthetic", fetchFn: fetch })
  const failure = await client
    .filesUpload({
      content: new Uint8Array([1, 2, 3]),
      filename: "test.bin",
      title: "test",
      channelId: "C123",
      threadTs: null,
      initialComment: null,
    })
    .catch((error: unknown) => error)
  expect(failure).toMatchObject({
    message: "slack file upload: invalid prepare response",
    cause: { name: "ZodError" },
  })
  expect(fetch).toHaveBeenCalledOnce()
})
