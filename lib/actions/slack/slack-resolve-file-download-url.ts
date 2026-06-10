import { z } from "zod"
import { slackCall } from "@/actions/slack/slack-call"

type Props = {
  botToken: string
  fileId: string
}

export const slackResolveFileDownloadUrl = async (props: Props): Promise<string> => {
  const response = await slackCall({
    botToken: props.botToken,
    method: "files.info",
    body: { file: props.fileId },
  })
  const parsed = filesInfoResponseSchema.safeParse(response)
  if (!parsed.success) {
    throw new Error("files.info response did not include url_private_download")
  }

  return parsed.data.file.url_private_download
}

const filesInfoResponseSchema = z.object({
  ok: z.literal(true),
  file: z.object({
    url_private_download: z.string().url(),
  }),
})
