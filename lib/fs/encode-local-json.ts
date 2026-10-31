import { DEFAULT_LOCAL_DATA_MAX_BYTES } from "@/fs/local-data-limits"

export function encodeLocalJson(value: unknown): string {
  const encoded = JSON.stringify(value, null, 2)
  if (encoded === undefined)
    throw new Error("Value cannot be represented as JSON; existing state was not replaced")
  const document = `${encoded}\n`
  const bytes = Buffer.byteLength(document, "utf8")
  if (bytes > DEFAULT_LOCAL_DATA_MAX_BYTES)
    throw Object.assign(
      new Error(
        `Local JSON exceeds the ${DEFAULT_LOCAL_DATA_MAX_BYTES} byte write limit (${bytes} bytes); existing state was not replaced`,
      ),
      { code: "LOCAL_DATA_TOO_LARGE" },
    )
  return document
}
