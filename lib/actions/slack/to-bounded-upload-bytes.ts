import { Buffer } from "node:buffer"

type Props = {
  chunks: AsyncIterable<Uint8Array>
  maxBytes: number
}

export type BoundedUploadBytes = {
  content: Uint8Array
  exceedsLimit: boolean
}

export const toBoundedUploadBytes = async (props: Props): Promise<BoundedUploadBytes> => {
  const chunks: Uint8Array[] = []
  const collected = { byteLength: 0 }

  for await (const chunk of props.chunks) {
    collected.byteLength += chunk.byteLength
    if (collected.byteLength > props.maxBytes) {
      return { content: new Uint8Array(), exceedsLimit: true }
    }
    chunks.push(chunk)
  }

  return {
    content: Buffer.concat(chunks, collected.byteLength),
    exceedsLimit: false,
  }
}
