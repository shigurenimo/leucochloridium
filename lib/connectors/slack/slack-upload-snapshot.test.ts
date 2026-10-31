import { expect, it } from "vitest"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"
import { LeucoMemorySlackWebClient } from "@/connectors/slack/leuco-memory-slack-web-client"

it.each(["bytes", "metadata"])(
  "keeps upload %s stable while preparing the external upload",
  async (change) => {
    const prepared = Promise.withResolvers<Response>()
    const started = Promise.withResolvers<void>()
    const observed: { bytes: number[]; filename: string; completed: unknown } = {
      bytes: [],
      filename: "",
      completed: null,
    }
    const client = new LeucoFetchSlackWebClient({
      botToken: "test",
      fetchFn: async (url, init) => {
        if (String(url).endsWith("/files.getUploadURLExternal")) {
          started.resolve()
          return prepared.promise
        }
        if (String(url).endsWith("/files.completeUploadExternal")) {
          const body = new URLSearchParams(String(init?.body))
          observed.completed = {
            files: JSON.parse(body.get("files") ?? "null"),
            channel_id: body.get("channel_id"),
            thread_ts: body.get("thread_ts"),
            initial_comment: body.get("initial_comment"),
          }
          return Response.json({ ok: true })
        }
        if (!(init?.body instanceof FormData)) throw new Error("Expected upload form")
        const file = init.body.get("file")
        if (!(file instanceof File)) throw new Error("Expected upload file")
        observed.filename = file.name
        observed.bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
        return new Response(null)
      },
    })
    const args = {
      content: new Uint8Array([1, 2, 3]),
      filename: "original.bin",
      title: "Original",
      channelId: "C-original",
      threadTs: "1.000",
      initialComment: "original comment",
    }
    const pending = client.filesUpload(args)
    await started.promise
    if (change === "bytes") {
      args.content.fill(9)
      args.content = new Uint8Array([7, 8])
    } else {
      args.filename = "changed.bin"
      args.title = "Changed"
      args.channelId = "C-changed"
      args.threadTs = "2.000"
      args.initialComment = "changed comment"
    }
    prepared.resolve(
      Response.json({ ok: true, upload_url: "https://files.slack.com/upload/test", file_id: "F1" }),
    )
    expect(await pending).toEqual({ fileId: "F1" })
    expect(observed).toEqual({
      bytes: [1, 2, 3],
      filename: "original.bin",
      completed: {
        files: [{ id: "F1", title: "Original" }],
        channel_id: "C-original",
        thread_ts: "1.000",
        initial_comment: "original comment",
      },
    })
  },
)

it("keeps the Memory upload record independent of caller mutations", async () => {
  const client = new LeucoMemorySlackWebClient()
  const args = {
    content: new Uint8Array([1, 2, 3]),
    filename: "original.bin",
    title: "Original",
    channelId: "C-original",
    threadTs: null,
    initialComment: null,
  }
  const pending = client.filesUpload(args)
  args.content.fill(9)
  args.channelId = "C-changed"
  await pending
  expect(client.calls.filesUpload[0]?.channelId).toBe("C-original")
  expect(Array.from(client.calls.filesUpload[0]!.content)).toEqual([1, 2, 3])
})
