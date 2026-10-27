import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"
import { downloadResponseToFile } from "@/fs/download-response-to-file"

type Props = {
  botToken: string
  url: string
  outputPath: string
  maxBytes?: number
  timeoutMs?: number
  idleTimeoutMs?: number
}
export const slackDownloadFile = async (
  props: Props,
): Promise<{ outputPath: string; size: number }> =>
  downloadResponseToFile({
    ...props,
    fetchResponse: (signal) => fetchSlackFile(props.url, props.botToken, props.timeoutMs, signal),
  })
