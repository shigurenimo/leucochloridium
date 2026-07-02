import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { fetchSlackFile } from "@/actions/slack/fetch-slack-file"

type Props = {
  botToken: string
  url: string
  outputPath: string
}

export const slackDownloadFile = async (
  props: Props,
): Promise<{ outputPath: string; size: number }> => {
  const response = await fetchSlackFile(props.url, props.botToken)

  if (!response.ok) {
    throw new Error(`download failed: ${response.status} ${response.statusText}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  await mkdir(dirname(props.outputPath), { recursive: true })
  await Bun.write(props.outputPath, bytes)

  return { outputPath: props.outputPath, size: bytes.byteLength }
}
