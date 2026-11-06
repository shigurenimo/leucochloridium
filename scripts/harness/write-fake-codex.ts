import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const fixture = resolve(import.meta.dir, "..", "fixtures", "fake-codex.ts")

export function writeFakeCodex(directory: string): string {
  const path = join(directory, "codex")
  mkdirSync(directory, { recursive: true })
  writeFileSync(path, `#!/bin/sh\nexec '${process.execPath}' '${fixture}' "$@"\n`, {
    mode: 0o700,
  })
  return path
}
