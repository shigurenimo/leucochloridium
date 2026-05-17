import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LeucoCodexAgentStore } from "@/engine/codex/codex-agent-store"

describe("LeucoCodexAgentStore", () => {
  let cwd = ""

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "leuco-agents-"))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it("getDir resolves project to <cwd>/.codex/agents", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    expect(store.getDir("project")).toBe(join(cwd, ".codex", "agents"))
  })

  it("getDir resolves user to ~/.codex/agents", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    expect(store.getDir("user")).toMatch(/\.codex\/agents$/)
  })

  it("list returns [] when the dir is missing", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    expect(store.list("project")).toEqual([])
  })

  it("add creates a TOML file with required fields", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    const path = store.add({
      scope: "project",
      name: "reviewer",
      description: "Code review agent",
      developerInstructions: "Review code carefully.",
      model: null,
    })

    expect(path).toBe(join(cwd, ".codex", "agents", "reviewer.toml"))

    const text = readFileSync(path, "utf8")
    expect(text).toContain('name = "reviewer"')
    expect(text).toContain('description = "Code review agent"')
    expect(text).toContain('developer_instructions = """\nReview code carefully.\n"""')
    expect(text).not.toContain("model =")
  })

  it("add includes model line when provided", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    const path = store.add({
      scope: "project",
      name: "fast",
      description: "Fast agent",
      developerInstructions: "Be fast.",
      model: "gpt-5",
    })

    const text = readFileSync(path, "utf8")
    expect(text).toContain('model = "gpt-5"')
  })

  it("add escapes double quotes and backslashes", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    const path = store.add({
      scope: "project",
      name: "quoter",
      description: 'has "quotes" and \\ backslash',
      developerInstructions: "ok",
      model: null,
    })

    const text = readFileSync(path, "utf8")
    expect(text).toContain('description = "has \\"quotes\\" and \\\\ backslash"')
  })

  it("add rejects invalid names", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    expect(() =>
      store.add({
        scope: "project",
        name: "Bad-Name",
        description: "x",
        developerInstructions: "x",
        model: null,
      }),
    ).toThrow()
  })

  it("add rejects duplicate names", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    store.add({
      scope: "project",
      name: "dup",
      description: "x",
      developerInstructions: "x",
      model: null,
    })
    expect(() =>
      store.add({
        scope: "project",
        name: "dup",
        description: "x",
        developerInstructions: "x",
        model: null,
      }),
    ).toThrow()
  })

  it("list reflects added agents with their scope", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    store.add({
      scope: "project",
      name: "one",
      description: "x",
      developerInstructions: "x",
      model: null,
    })
    store.add({
      scope: "project",
      name: "two",
      description: "x",
      developerInstructions: "x",
      model: null,
    })

    const list = store.list("project")
    expect(list.map((e) => e.name).sort()).toEqual(["one", "two"])
    expect(list.every((e) => e.scope === "project")).toBe(true)
  })

  it("remove deletes the TOML file", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    const created = store.add({
      scope: "project",
      name: "tmp",
      description: "x",
      developerInstructions: "x",
      model: null,
    })

    const result = store.remove("project", "tmp")
    expect(result).toBe(created)
    expect(existsSync(created)).toBe(false)
  })

  it("remove throws when target is missing", () => {
    const store = new LeucoCodexAgentStore({ cwd })
    expect(() => store.remove("project", "ghost")).toThrow()
  })
})
