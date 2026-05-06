import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Project } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const sampleProject = (overrides: Partial<Project> = {}): Project => ({
  name: "demo",
  path: "/tmp/demo",
  agents: [
    {
      name: "reviewer",
      enabled: true,
      useCommonInstructions: true,
      prompts: ["friendly" as const],
      channels: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          name: "slack",
          type: "slack",
          enabled: true,
          botToken: "",
          appToken: "",
          ackMode: "mention" as const,
          ackIcons: {
            progress: "hourglass_flowing_sand",
            success: "white_check_mark",
            error: "x",
          },
        },
      ],
    },
  ],
  ...overrides,
})

describe("LeucoProjectStore", () => {
  let home = ""
  let store: LeucoProjectStore

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-store-"))
    store = new LeucoProjectStore({ paths: new LeucoPaths({ home }) })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("returns [] when no projects directory exists yet", () => {
    expect(store.list()).toEqual([])
  })

  it("save() writes <home>/.leuco/projects/<name>/settings.json with chmod 600", () => {
    const project = sampleProject()
    const result = store.save(project)
    expect(result).toBe(join(home, ".leuco", "projects", "demo", "settings.json"))
    if (result instanceof Error) throw result

    const text = readFileSync(result, "utf8")
    expect(text).toContain('"name": "demo"')
    expect(text.endsWith("\n")).toBe(true)

    const mode = statSync(result).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("round-trips data through save → load", () => {
    const project = sampleProject({
      agents: [
        {
          name: "reviewer",
          enabled: true,
          useCommonInstructions: true,
          prompts: ["friendly" as const],
          channels: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              name: "slack",
              type: "slack",
              enabled: true,
              botToken: "xoxb-secret",
              appToken: "xapp-secret",
              ackMode: "mention" as const,
              ackIcons: {
                progress: "hourglass_flowing_sand",
                success: "white_check_mark",
                error: "x",
              },
            },
          ],
        },
      ],
    })
    store.save(project)
    expect(store.load("demo")).toEqual(project)
  })

  it("list() enumerates project directories", () => {
    store.save(sampleProject({ name: "alpha", path: "/a" }))
    store.save(sampleProject({ name: "beta", path: "/b" }))

    const result = store.list()
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.map((p) => p.name).sort()).toEqual(["alpha", "beta"])
  })

  it("resolveByCwd() finds a project whose path matches cwd", () => {
    store.save(sampleProject({ name: "alpha", path: "/x/a" }))
    const result = store.resolveByCwd("/x/a")
    expect(result).not.toBeInstanceOf(Error)
    if (result instanceof Error) return
    expect(result.name).toBe("alpha")
  })

  it("resolveByCwd() returns Error when no project matches", () => {
    store.save(sampleProject({ name: "alpha", path: "/x/a" }))
    const result = store.resolveByCwd("/y/b")
    expect(result).toBeInstanceOf(Error)
  })

  it("returns Error when settings.json contains invalid JSON", () => {
    const path = store.getPaths().projectSettingsPath("demo")
    require("node:fs").mkdirSync(require("node:path").dirname(path), { recursive: true })
    require("node:fs").writeFileSync(path, "{ not json")

    expect(store.load("demo")).toBeInstanceOf(Error)
  })

  it("returns Error when zod validation fails", () => {
    const path = store.getPaths().projectSettingsPath("demo")
    require("node:fs").mkdirSync(require("node:path").dirname(path), { recursive: true })
    require("node:fs").writeFileSync(path, JSON.stringify({ name: "", path: "p", agents: [] }))
    expect(store.load("demo")).toBeInstanceOf(Error)
  })

  it("remove() deletes the project directory", () => {
    store.save(sampleProject())
    store.remove("demo")
    expect(store.load("demo")).toBeInstanceOf(Error)
  })
})
