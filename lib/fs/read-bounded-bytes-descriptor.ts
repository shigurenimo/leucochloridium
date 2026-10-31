import { readSync } from "node:fs"

/** Detect growth after stat while preserving every byte, including invalid UTF-8. */
export function readBoundedBytesDescriptor(descriptor: number, maxBytes: number): Buffer {
  const buffer = new Uint8Array(Math.min(64 * 1024, maxBytes + 1))
  const chunks: Uint8Array[] = []
  const read = { bytes: 0 }
  while (true) {
    const length = readSync(
      descriptor,
      buffer,
      0,
      Math.min(buffer.length, maxBytes + 1 - read.bytes),
      null,
    )
    if (length === 0) return Buffer.concat(chunks, read.bytes)
    read.bytes += length
    if (read.bytes > maxBytes) throw new Error(`Local data exceeds the ${maxBytes} byte read limit`)
    chunks.push(buffer.slice(0, length))
  }
}
