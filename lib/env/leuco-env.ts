import { existsSync, readFileSync } from "node:fs"
import { type CliEnv, cliEnvSchema } from "@/env/cli-env-schema"

type Props = {
  env: NodeJS.ProcessEnv
}

export type LoadEnvFileResult = {
  path: string
  loaded: boolean
  keys: string[]
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Read/parse process environment + .env files.
 *
 * `loadFile()` mutates the underlying env (typically `process.env`) but only
 * for keys not already present, mirroring the behavior most CLIs expect.
 * `parseCli()` validates the runtime env against `cliEnvSchema` and returns
 * either the parsed shape or a flat `Error`.
 */
export class LeucoEnv {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  getEnv(): NodeJS.ProcessEnv {
    return this.props.env
  }

  loadFile(path: string): LoadEnvFileResult {
    if (!existsSync(path)) return { path, loaded: false, keys: [] }

    const content = readFileSync(path, "utf8")
    const keys: string[] = []

    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim()
      if (line.length === 0 || line.startsWith("#")) continue

      const eq = line.indexOf("=")
      if (eq <= 0) continue

      const key = line.slice(0, eq).trim()
      if (!KEY_PATTERN.test(key)) continue
      if (this.props.env[key] !== undefined) continue

      const value = parseValue(line.slice(eq + 1).trim())

      this.props.env[key] = value
      keys.push(key)
    }

    return { path, loaded: true, keys }
  }

  parseCli(): CliEnv | Error {
    const result = cliEnvSchema.safeParse(this.props.env)
    if (result.success) return result.data

    const lines = result.error.issues.map((issue) => {
      const key = issue.path.join(".")
      return `${key}: ${issue.message}`
    })
    return new Error(lines.join("; "))
  }
}

/**
 * Strip matched outer quotes only when they truly bracket the value:
 *   - the string must start AND end with the same quote character
 *   - the trailing quote must not be escaped (`\"` / `\'`)
 *   - inside a double-quoted value, `\n` / `\r` / `\t` / `\"` / `\\` are
 *     interpreted, matching the common dotenv convention
 *   - single-quoted values pass through verbatim (no escape interpretation)
 *
 * Unquoted values are returned as-is. The old naive `slice(1, -1)` chopped
 * arbitrary characters off `"foo`/`bar"` and similar half-quoted shapes.
 */
const parseValue = (raw: string): string => {
  if (raw.length < 2) return raw
  const first = raw[0]
  const last = raw[raw.length - 1]
  if (first !== '"' && first !== "'") return raw
  if (last !== first) return raw

  // Reject when the trailing quote is escaped — the value is mid-token, not
  // properly quoted, so leave it alone rather than stripping random characters.
  let backslashes = 0
  for (let i = raw.length - 2; i >= 0 && raw[i] === "\\"; i--) backslashes += 1
  if (backslashes % 2 === 1) return raw

  const inner = raw.slice(1, -1)
  if (first === "'") return inner
  return decodeDoubleQuoted(inner)
}

/**
 * Decode the body of a double-quoted dotenv value in a single left-to-right
 * pass. A naive chain of `.replace` calls would unescape `\\n` (literal
 * backslash + 'n') into a real newline because the `\\n` replacement runs
 * before the `\\\\` replacement; scanning once avoids that ordering trap.
 */
const decodeDoubleQuoted = (text: string): string => {
  let out = ""
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch !== "\\" || i === text.length - 1) {
      out += ch
      continue
    }
    const next = text[i + 1]
    i += 1
    if (next === "n") out += "\n"
    else if (next === "r") out += "\r"
    else if (next === "t") out += "\t"
    else if (next === '"') out += '"'
    else if (next === "\\") out += "\\"
    else out += `\\${next}`
  }
  return out
}
