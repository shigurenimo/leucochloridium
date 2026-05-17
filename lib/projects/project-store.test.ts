import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Project, ScheduleEntry } from "@/config/config-schema"
import { LeucoPaths } from "@/paths/leuco-paths"
import { LeucoProjectStore } from "@/projects/project-store"

const DEMO_ID = "00000000-0000-4000-8000-000000000000"

const sampleProject = (overrides: Partial<Project> = {}): Project => ({
  id: DEMO_ID,
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

  it("save() writes <home>/.leuco/projects/<id>/settings.json with chmod 600", () => {
    const project = sampleProject()
    const result = store.save(project)
    expect(result).toBe(join(home, ".leuco", "projects", DEMO_ID, "settings.json"))

    const text = readFileSync(result, "utf8")
    expect(text).toContain(`"id": "${DEMO_ID}"`)
    expect(text).toContain('"name": "demo"')
    expect(text.endsWith("\n")).toBe(true)

    const mode = statSync(result).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("round-trips data through save → load by id", () => {
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
    expect(store.load(DEMO_ID)).toEqual(project)
  })

  it("list() enumerates project directories", () => {
    store.save(
      sampleProject({ id: "11111111-1111-4111-8111-aaaaaaaaaaaa", name: "alpha", path: "/a" }),
    )
    store.save(
      sampleProject({ id: "22222222-2222-4222-8222-bbbbbbbbbbbb", name: "beta", path: "/b" }),
    )

    const result = store.list()
    expect(result.map((p) => p.name).sort()).toEqual(["alpha", "beta"])
  })

  it("resolveByName() returns a single match", () => {
    store.save(
      sampleProject({ id: "11111111-1111-4111-8111-aaaaaaaaaaaa", name: "alpha", path: "/x/a" }),
    )
    const result = store.resolveByName("alpha")
    expect(result.path).toBe("/x/a")
  })

  it("resolveByName() throws when ambiguous", () => {
    store.save(
      sampleProject({ id: "11111111-1111-4111-8111-aaaaaaaaaaaa", name: "web", path: "/a/web" }),
    )
    store.save(
      sampleProject({ id: "22222222-2222-4222-8222-bbbbbbbbbbbb", name: "web", path: "/b/web" }),
    )
    expect(() => store.resolveByName("web")).toThrow()
  })

  it("resolveByName() disambiguates by preferCwd", () => {
    store.save(
      sampleProject({ id: "11111111-1111-4111-8111-aaaaaaaaaaaa", name: "web", path: "/a/web" }),
    )
    store.save(
      sampleProject({ id: "22222222-2222-4222-8222-bbbbbbbbbbbb", name: "web", path: "/b/web" }),
    )
    const result = store.resolveByName("web", { preferCwd: "/b/web" })
    expect(result.path).toBe("/b/web")
  })

  it("resolveByCwd() finds a project whose path matches cwd", () => {
    store.save(sampleProject({ name: "alpha", path: "/x/a" }))
    const result = store.resolveByCwd("/x/a")
    expect(result.name).toBe("alpha")
  })

  it("resolveByCwd() throws when no project matches", () => {
    store.save(sampleProject({ name: "alpha", path: "/x/a" }))
    expect(() => store.resolveByCwd("/y/b")).toThrow()
  })

  it("throws when settings.json contains invalid JSON", () => {
    const path = store.getPaths().projectSettingsPath(DEMO_ID)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{ not json")
    expect(() => store.load(DEMO_ID)).toThrow()
  })

  it("throws when zod validation fails", () => {
    const path = store.getPaths().projectSettingsPath(DEMO_ID)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ id: DEMO_ID, name: "", path: "p", agents: [] }))
    expect(() => store.load(DEMO_ID)).toThrow()
  })

  it("remove() deletes the project directory", () => {
    store.save(sampleProject())
    store.remove(DEMO_ID)
    expect(() => store.load(DEMO_ID)).toThrow()
  })

  it("list() migrates a legacy name-keyed directory to id-keyed", () => {
    const paths = store.getPaths()
    const legacyDir = join(paths.projectsRoot(), "legacy-demo")
    mkdirSync(legacyDir, { recursive: true })
    const legacySettings = {
      name: "legacy-demo",
      path: "/tmp/legacy-demo",
      agents: [],
    }
    writeFileSync(join(legacyDir, "settings.json"), JSON.stringify(legacySettings, null, 2))

    const result = store.list()
    expect(result).toHaveLength(1)
    const project = result[0]!
    expect(project.name).toBe("legacy-demo")
    expect(typeof project.id).toBe("string")
    expect(project.id.length).toBeGreaterThan(0)

    const newDir = paths.projectDir(project.id)
    expect(statSync(newDir).isDirectory()).toBe(true)
    const newJson = JSON.parse(readFileSync(join(newDir, "settings.json"), "utf8"))
    expect(newJson.id).toBe(project.id)
  })

  describe("schedule entries", () => {
    const projectWithScheduleChannel = (): Project =>
      sampleProject({
        agents: [
          {
            name: "reviewer",
            enabled: true,
            useCommonInstructions: true,
            prompts: ["friendly" as const],
            channels: [
              {
                id: "33333333-3333-4333-8333-333333333333",
                name: "cron",
                type: "schedule",
                enabled: true,
                entries: [],
              },
            ],
          },
        ],
      })

    const sampleEntry = (overrides: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
      id: "44444444-4444-4444-8444-444444444444",
      name: "morning-standup",
      runAt: "0 9 * * *",
      prompt: "summarize yesterday's work",
      enabled: true,
      ...overrides,
    })

    beforeEach(() => {
      store.save(projectWithScheduleChannel())
    })

    it("addScheduleEntry appends a new entry", () => {
      store.addScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entry: sampleEntry(),
      })

      const project = store.load(DEMO_ID)
      const channel = project.agents[0]!.channels[0]!
      if (channel.type !== "schedule") throw new Error("expected schedule channel")
      expect(channel.entries.map((e) => e.name)).toEqual(["morning-standup"])
    })

    it("addScheduleEntry rejects duplicate name", () => {
      store.addScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entry: sampleEntry(),
      })
      expect(() =>
        store.addScheduleEntry({
          projectId: DEMO_ID,
          agentName: "reviewer",
          channelName: "cron",
          entry: sampleEntry({ id: "55555555-5555-4555-8555-555555555555" }),
        }),
      ).toThrow()
    })

    it("addScheduleEntry rejects when channel is not schedule", () => {
      store.save(sampleProject())
      expect(() =>
        store.addScheduleEntry({
          projectId: DEMO_ID,
          agentName: "reviewer",
          channelName: "slack",
          entry: sampleEntry(),
        }),
      ).toThrow()
    })

    it("removeScheduleEntry by id removes the entry", () => {
      store.addScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entry: sampleEntry(),
      })
      store.removeScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entryIdOrName: "44444444-4444-4444-8444-444444444444",
      })

      const project = store.load(DEMO_ID)
      const channel = project.agents[0]!.channels[0]!
      if (channel.type !== "schedule") throw new Error("expected schedule channel")
      expect(channel.entries).toEqual([])
    })

    it("removeScheduleEntry by name removes the entry", () => {
      store.addScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entry: sampleEntry(),
      })
      store.removeScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entryIdOrName: "morning-standup",
      })
    })

    it("removeScheduleEntry throws when not found", () => {
      expect(() =>
        store.removeScheduleEntry({
          projectId: DEMO_ID,
          agentName: "reviewer",
          channelName: "cron",
          entryIdOrName: "nope",
        }),
      ).toThrow()
    })

    it("updateScheduleEntry patches one entry by id", () => {
      store.addScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entry: sampleEntry(),
      })
      store.updateScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entryId: "44444444-4444-4444-8444-444444444444",
        patch: { enabled: false },
      })

      const project = store.load(DEMO_ID)
      const channel = project.agents[0]!.channels[0]!
      if (channel.type !== "schedule") throw new Error("expected schedule channel")
      expect(channel.entries[0]!.enabled).toBe(false)
    })

    it("updateScheduleEntry preserves id even if patch tries to override", () => {
      store.addScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entry: sampleEntry(),
      })
      store.updateScheduleEntry({
        projectId: DEMO_ID,
        agentName: "reviewer",
        channelName: "cron",
        entryId: "44444444-4444-4444-8444-444444444444",
        patch: { id: "evil" } as Partial<ScheduleEntry>,
      })
      const project = store.load(DEMO_ID)
      const channel = project.agents[0]!.channels[0]!
      if (channel.type !== "schedule") throw new Error("expected schedule channel")
      expect(channel.entries[0]!.id).toBe("44444444-4444-4444-8444-444444444444")
    })
  })
})
