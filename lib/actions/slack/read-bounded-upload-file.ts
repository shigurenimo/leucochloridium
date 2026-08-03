import { open } from "node:fs/promises"
import {
  toBoundedUploadBytes,
  type BoundedUploadBytes,
} from "@/actions/slack/to-bounded-upload-bytes"

type Props = {
  path: string
  maxBytes: number
}

export type BoundedUploadFile = BoundedUploadBytes & {
  isFile: boolean
}

export const readBoundedUploadFile = async (props: Props): Promise<BoundedUploadFile> => {
  const fileHandle = await open(props.path, "r")

  try {
    const fileStats = await fileHandle.stat()
    if (!fileStats.isFile()) {
      return { content: new Uint8Array(), exceedsLimit: false, isFile: false }
    }
    if (fileStats.size > props.maxBytes) {
      return { content: new Uint8Array(), exceedsLimit: true, isFile: true }
    }

    // `end` is inclusive, so at most maxBytes + 1 reaches memory. The extra
    // byte detects a file that grew after `stat` without reopening its path.
    const bounded = await toBoundedUploadBytes({
      chunks: fileHandle.createReadStream({
        start: 0,
        end: props.maxBytes,
        autoClose: false,
      }),
      maxBytes: props.maxBytes,
    })
    return { ...bounded, isFile: true }
  } finally {
    await fileHandle.close()
  }
}
