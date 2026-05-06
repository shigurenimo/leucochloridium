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

      let value = line.slice(eq + 1).trim()
      if (value.length >= 2) {
        const first = value[0]
        const last = value[value.length - 1]
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
          value = value.slice(1, -1)
        }
      }

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
