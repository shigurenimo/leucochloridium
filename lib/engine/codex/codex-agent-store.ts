import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type CodexAgentScope = "project" | "user"

export type CodexAgentEntry = {
  name: string
  scope: CodexAgentScope
  path: string
}

export type CodexAgentSpec = {
  name: string
  description: string
  developerInstructions: string
  model: string | null
}

type AddProps = {
  scope: CodexAgentScope
  name: string
  description: string
  developerInstructions: string
  model: string | null
}

type ReadProps = {
  scope: CodexAgentScope
  name: string
}

type Props = {
  cwd: string
}

const NAME_PATTERN = /^[a-z][a-z0-9_-]*$/

/**
 * CRUD over codex subagent definitions (`.codex/agents/<name>.toml`).
 *
 * Project scope writes under `<cwd>/.codex/agents/`. User scope writes under
 * `~/.codex/agents/`. Codex itself reads these files; this class only manages
 * their lifecycle from leuco.
 */
export class LeucoCodexAgentStore {
  constructor(private readonly props: Props) {
    Object.freeze(this)
  }

  getDir(scope: CodexAgentScope): string {
    if (scope === "user") return join(homedir(), ".codex", "agents")
    return join(this.props.cwd, ".codex", "agents")
  }

  list(scope: CodexAgentScope): CodexAgentEntry[] {
    const dir = this.getDir(scope)
    if (!existsSync(dir)) return []

    return readdirSync(dir)
      .filter((file) => file.endsWith(".toml"))
      .map((file) => ({
        name: file.slice(0, -".toml".length),
        scope,
        path: join(dir, file),
      }))
  }

  add(addProps: AddProps): string | Error {
    if (!NAME_PATTERN.test(addProps.name)) {
      return new Error(`invalid agent name: ${addProps.name} (expected ^[a-z][a-z0-9_-]*$)`)
    }

    const dir = this.getDir(addProps.scope)
    const path = join(dir, `${addProps.name}.toml`)
    if (existsSync(path)) {
      return new Error(`agent already exists: ${path}`)
    }

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    const lines: string[] = [
      `name = ${tomlString(addProps.name)}`,
      `description = ${tomlString(addProps.description)}`,
      `developer_instructions = ${tomlMultiline(addProps.developerInstructions)}`,
    ]

    if (addProps.model !== null) {
      lines.push(`model = ${tomlString(addProps.model)}`)
    }

    writeFileSync(path, `${lines.join("\n")}\n`)
    return path
  }

  /**
   * Read and parse `<scope>/.codex/agents/<name>.toml`. Recognises only the
   * subset leuco itself writes (`name`, `description`, `developer_instructions`,
   * optional `model`) — richer TOML constructs are passed through to codex
   * directly via the on-disk file rather than re-serialised here.
   */
  read(props: ReadProps): CodexAgentSpec | Error {
    const path = join(this.getDir(props.scope), `${props.name}.toml`)
    if (!existsSync(path)) return new Error(`agent not found: ${path}`)

    try {
      const text = readFileSync(path, "utf8")
      const fields = parseAgentToml(text)
      return {
        name: fields.name ?? props.name,
        description: fields.description ?? "",
        developerInstructions: fields.developer_instructions ?? "",
        model: fields.model ?? null,
      }
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }

  rename(scope: CodexAgentScope, oldName: string, newName: string): string | Error {
    const spec = this.read({ scope, name: oldName })
    if (spec instanceof Error) return spec

    const removed = this.remove(scope, oldName)
    if (removed instanceof Error) return removed

    return this.add({
      scope,
      name: newName,
      description: spec.description,
      developerInstructions: spec.developerInstructions,
      model: spec.model,
    })
  }

  remove(scope: CodexAgentScope, name: string): string | Error {
    const path = join(this.getDir(scope), `${name}.toml`)

    if (!existsSync(path)) {
      return new Error(`agent not found: ${path}`)
    }

    try {
      unlinkSync(path)
      return path
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }
  }
}

const tomlString = (value: string): string => {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

const tomlMultiline = (value: string): string => {
  const escaped = value.replace(/"""/g, '\\"\\"\\"')
  return `"""\n${escaped}\n"""`
}

/**
 * Minimal TOML reader that round-trips with `tomlString` / `tomlMultiline`
 * above. Recognises top-level `key = "..."` and `key = """\n...\n"""` only;
 * other constructs (tables, arrays, numbers) are ignored, which is enough for
 * the agent files leuco itself writes.
 */
const parseAgentToml = (text: string): Record<string, string> => {
  const accumulator = new TomlAccumulator()
  for (const line of text.split("\n")) {
    accumulator.feed(line)
  }
  return accumulator.build()
}

/**
 * Inner state machine for `parseAgentToml`. Mutation is hidden behind `feed`
 * so callers do not need `let` to track the current multiline-string key.
 */
class TomlAccumulator {
  private readonly result: Record<string, string> = {}
  private currentKey: string | null = null
  private buffer: string[] = []

  feed(line: string): void {
    if (this.currentKey !== null) {
      if (line.trim() === '"""') {
        this.result[this.currentKey] = this.buffer.join("\n").replace(/\\"\\"\\"/g, '"""')
        this.currentKey = null
        this.buffer = []
        return
      }
      this.buffer.push(line)
      return
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (!match) return
    const fieldKey = match[1]!
    const valuePart = match[2]!

    if (valuePart.startsWith('"""')) {
      this.currentKey = fieldKey
      this.buffer = []
      return
    }

    const stringMatch = valuePart.match(/^"((?:\\.|[^\\"])*)"\s*(?:#.*)?$/)
    if (!stringMatch) return
    this.result[fieldKey] = stringMatch[1]!.replace(/\\\\/g, "\\").replace(/\\"/g, '"')
  }

  build(): Record<string, string> {
    return this.result
  }
}
