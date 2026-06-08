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
import { tomlMultiline } from "@/engine/codex/toml-multiline"
import { tomlString } from "@/engine/codex/toml-string"

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

  add(addProps: AddProps): string {
    if (!NAME_PATTERN.test(addProps.name)) {
      throw new Error(`invalid agent name: ${addProps.name} (expected ^[a-z][a-z0-9_-]*$)`)
    }

    const dir = this.getDir(addProps.scope)
    const path = join(dir, `${addProps.name}.toml`)
    if (existsSync(path)) {
      throw new Error(`agent already exists: ${path}`)
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
  read(props: ReadProps): CodexAgentSpec {
    const path = join(this.getDir(props.scope), `${props.name}.toml`)
    if (!existsSync(path)) throw new Error(`agent not found: ${path}`)

    const text = readFileSync(path, "utf8")
    const fields = parseAgentToml(text)
    return {
      name: fields.name ?? props.name,
      description: fields.description ?? "",
      developerInstructions: fields.developer_instructions ?? "",
      model: fields.model ?? null,
    }
  }

  /**
   * Rename `<oldName>.toml` → `<newName>.toml`. The destination is written
   * before the source is removed so a failed `add` (invalid new name,
   * already-exists, write error) does not lose the spec — leaves the old
   * TOML intact and re-throws.
   */
  rename(scope: CodexAgentScope, oldName: string, newName: string): string {
    const spec = this.read({ scope, name: oldName })
    const newPath = this.add({
      scope,
      name: newName,
      description: spec.description,
      developerInstructions: spec.developerInstructions,
      model: spec.model,
    })
    try {
      this.remove(scope, oldName)
    } catch (error) {
      // Rollback the new TOML to keep the operation atomic-ish: either both
      // files exist (caller can retry) or only the old one survives.
      try {
        this.remove(scope, newName)
      } catch {
        // best-effort cleanup
      }
      throw error
    }
    return newPath
  }

  remove(scope: CodexAgentScope, name: string): string {
    const path = join(this.getDir(scope), `${name}.toml`)
    if (!existsSync(path)) throw new Error(`agent not found: ${path}`)
    unlinkSync(path)
    return path
  }
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
