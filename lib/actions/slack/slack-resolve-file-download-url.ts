import { z } from "zod"
import { LeucoFetchSlackWebClient } from "@/connectors/slack/leuco-fetch-slack-web-client"

type Props = {
  botToken: string
  fileId: string
  signal?: AbortSignal
}

export const slackResolveFileDownloadUrl = async (props: Props): Promise<string> => {
  const client = new LeucoFetchSlackWebClient({ botToken: props.botToken, signal: props.signal })
  const response = await client.apiCall("files.info", { file: props.fileId })

  const parsed = filesInfoResponseSchema.safeParse(response)
  if (!parsed.success) {
    throw new Error("files.info response did not include url_private_download", {
      cause: parsed.error,
    })
  }

  return parsed.data.file.url_private_download
}

const filesInfoResponseSchema = z.object({
  file: z.object({
    url_private_download: z.string().url(),
  }),
})
