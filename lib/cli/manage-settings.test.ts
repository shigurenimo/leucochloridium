import { describe, expect, it, vi } from "vitest"
import { manageSettings } from "@/cli/manage-settings"
import { parseArguments } from "@/cli/parse-arguments"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"

describe("single settings commands", () => {
  it("saves only the selected key and stores only the credential reference", async () => {
    const store = new MemoryLeucoStore({
      slack: { credential: "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d", ackMode: "off" },
    })
    await manageSettings(parseArguments(["config", "set", "soul", '"/SOUL.md"']), store)
    expect(store.loadSettings().soul).toBe("/SOUL.md")
    expect(store.loadSettings().slack?.credential).toBe("6e6d9bcc-a07c-4c72-93f0-7eb651f9711d")
    const visible = await manageSettings(parseArguments(["config", "show"]), store)
    expect(JSON.stringify(visible)).not.toContain("secret")
    await manageSettings(parseArguments(["config", "set", "soul", "null"]), store)
    expect(store.loadSettings().soul).toBeNull()
  })
  it("saves reception rules without credentials and rejects invalid rules atomically", async () => {
    const store = new MemoryLeucoStore()
    await expect(
      manageSettings(
        parseArguments([
          "config",
          "set",
          "slackReception",
          '{"mentions":false,"reactionAdded":["eyes"],"allowedUsers":["U1"]}',
        ]),
        store,
      ),
    ).resolves.toEqual({ saved: "slackReception", restartRequired: true })
    const saved = store.loadSettings()
    expect(saved.slack).toBeNull()
    expect(saved.slackReception).toMatchObject({
      mentions: false,
      directMessages: true,
      participatingThreads: true,
      channelMessages: false,
      reactionAdded: ["eyes"],
      allowedUsers: ["U1"],
    })
    await expect(
      manageSettings(
        parseArguments(["config", "set", "slackReception", '{"mentions":"yes"}']),
        store,
      ),
    ).rejects.toThrow()
    expect(store.loadSettings()).toEqual(saved)
  })
  it("rejects unsupported settings without writing", async () => {
    const store = new MemoryLeucoStore()
    await expect(
      manageSettings(parseArguments(["config", "set", "projects", "[]"]), store),
    ).rejects.toThrow()
    expect(store.loadSettings().schedules).toEqual([])
  })
  it("adds and removes unique schedules without losing other settings", async () => {
    const store = new MemoryLeucoStore({ model: "native-override" })
    const add = parseArguments([
      "schedules",
      "add",
      "--name",
      "daily",
      "--run-at",
      "0 9 * * *",
      "--prompt",
      "check",
    ])
    await expect(manageSettings(add, store)).resolves.toEqual({ added: "daily" })
    await expect(manageSettings(add, store)).rejects.toMatchObject({ code: "USAGE" })
    expect(store.loadSettings().schedules).toHaveLength(1)
    await manageSettings(parseArguments(["schedules", "remove", "daily"]), store)
    expect(store.loadSettings().schedules).toEqual([])
    expect(store.loadSettings().model).toBe("native-override")
  })
  it("classifies invalid schedule time as input failure before any settings write", async () => {
    const store = new MemoryLeucoStore({ model: "keep-model" })
    const before = store.loadSettings()
    await expect(
      manageSettings(
        parseArguments([
          "schedules",
          "add",
          "--name",
          "invalid",
          "--run-at",
          "not-a-time",
          "--prompt",
          "probe",
        ]),
        store,
      ),
    ).rejects.toMatchObject({ code: "USAGE" })
    expect(store.loadSettings()).toEqual(before)
  })
})

it.each(["timezone", "timeZone", "repeat", "thread"])(
  "rejects an unsupported schedule field %s before writing settings",
  async (field) => {
    const store = new MemoryLeucoStore({ model: "keep-model" })
    const before = store.loadSettings()
    const update = vi.spyOn(store, "updateSettings")
    await expect(
      manageSettings(
        parseArguments([
          "config",
          "set",
          "schedules",
          JSON.stringify([
            { id: "one", name: "one", runAt: "0 9 * * *", prompt: "check", [field]: "UTC" },
          ]),
        ]),
        store,
      ),
    ).rejects.toMatchObject({
      code: "USAGE",
      details: {
        issues: [
          {
            code: "unrecognized_keys",
            path: ["schedules", "0"],
            message: expect.stringContaining(field),
          },
        ],
      },
    })
    expect(update).not.toHaveBeenCalled()
    expect(store.loadSettings()).toEqual(before)
  },
)

it.each(["turnTimeoutMs", "idleTimeoutMs"])("does not save overflowing %s", async (key) => {
  const store = new MemoryLeucoStore()
  const before = store.loadSettings()
  await expect(
    manageSettings(parseArguments(["config", "set", key, "2147483648"]), store),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings()).toEqual(before)
})

it.each(["missing", "ambiguous"])(
  "rejects a %s removal before entering a settings write",
  async (target) => {
    const store = new MemoryLeucoStore({
      schedules: [
        { id: "ambiguous", name: "first", runAt: "* * * * *", prompt: "first", enabled: true },
        { id: "second", name: "ambiguous", runAt: "* * * * *", prompt: "second", enabled: true },
      ],
    })
    const before = store.loadSettings()
    const update = vi.spyOn(store, "updateSettings")
    await expect(
      manageSettings(parseArguments(["schedules", "remove", target]), store),
    ).rejects.toMatchObject({ code: "USAGE" })
    expect(update).not.toHaveBeenCalled()
    expect(store.loadSettings()).toEqual(before)
  },
)

it("rechecks schedule removal against the settings acquired for the write", async () => {
  const store = new MemoryLeucoStore({
    schedules: [{ id: "one", name: "first", runAt: "* * * * *", prompt: "first", enabled: true }],
  })
  const update = store.updateSettings.bind(store)
  vi.spyOn(store, "updateSettings").mockImplementationOnce((transform) => {
    update((settings) => ({ ...settings, schedules: [], model: "concurrent-change" }))
    update(transform)
  })
  await expect(
    manageSettings(parseArguments(["schedules", "remove", "first"]), store),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings()).toMatchObject({ schedules: [], model: "concurrent-change" })
})

it.each([
  "not-a-time",
  "* * * *",
  "2000-01-01T00:00:00Z",
  "2999",
  "2999-01-01T09:00:00",
  "2999-02-29T09:00:00Z",
])("rejects a new invalid schedule through bulk config (%s)", async (runAt) => {
  const store = new MemoryLeucoStore()
  const before = store.loadSettings()
  await expect(
    manageSettings(
      parseArguments([
        "config",
        "set",
        "schedules",
        JSON.stringify([{ id: "one", name: "check", runAt, prompt: "check" }]),
      ]),
      store,
    ),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings()).toEqual(before)
})
it("allows retaining a past one-shot while adding a future schedule through bulk config", async () => {
  const old = {
    id: "old",
    name: "old",
    runAt: "2000-01-01T00:00:00Z",
    prompt: "catch up",
    enabled: true,
  }
  const store = new MemoryLeucoStore({ schedules: [old] })
  const schedules = [
    old,
    { id: "next", name: "next", runAt: "2999-01-01T00:00:00Z", prompt: "future" },
  ]
  await manageSettings(
    parseArguments(["config", "set", "schedules", JSON.stringify(schedules)]),
    store,
  )
  expect(store.loadSettings().schedules).toHaveLength(2)
})
it("rejects retiming an existing entry into the past through bulk config", async () => {
  const old = {
    id: "one",
    name: "check",
    runAt: "2999-01-01T00:00:00Z",
    prompt: "future",
    enabled: true,
  }
  const store = new MemoryLeucoStore({ schedules: [old] })
  const before = store.loadSettings()
  await expect(
    manageSettings(
      parseArguments([
        "config",
        "set",
        "schedules",
        JSON.stringify([{ ...old, runAt: "2000-01-01T00:00:00Z" }]),
      ]),
      store,
    ),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings()).toEqual(before)
})

it("rechecks creation-time validity against the fresh settings used for the write", async () => {
  const old = {
    id: "one",
    name: "check",
    runAt: "2000-01-01T00:00:00Z",
    prompt: "catch up",
    enabled: true,
  }
  const store = new MemoryLeucoStore({ schedules: [old] })
  const update = store.updateSettings.bind(store)
  vi.spyOn(store, "updateSettings").mockImplementationOnce((transform) => {
    update((settings) => ({ ...settings, schedules: [] }))
    update(transform)
  })
  await expect(
    manageSettings(parseArguments(["config", "set", "schedules", JSON.stringify([old])]), store),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings().schedules).toEqual([])
})

it("locates invalid and past schedule timestamps in bulk input", async () => {
  const store = new MemoryLeucoStore()
  const entry = { id: "one", name: "check", runAt: "not-a-time", prompt: "check" }
  await expect(
    manageSettings(parseArguments(["config", "set", "schedules", JSON.stringify([entry])]), store),
  ).rejects.toMatchObject({
    code: "USAGE",
    details: { issues: [{ path: ["schedules", "0", "runAt"] }] },
  })
  await expect(
    manageSettings(
      parseArguments([
        "config",
        "set",
        "schedules",
        JSON.stringify([{ ...entry, runAt: "2000-01-01T00:00:00Z" }]),
      ]),
      store,
    ),
  ).rejects.toMatchObject({ code: "USAGE", details: { location: "schedules[0].runAt" } })
})

it("does not register a prompt that cannot fit the scheduled runtime input", async () => {
  const store = new MemoryLeucoStore()
  await expect(
    manageSettings(
      parseArguments([
        "schedules",
        "add",
        "--name",
        "large",
        "--run-at",
        "* * * * *",
        "--prompt",
        "x".repeat(256 * 1024),
      ]),
      store,
    ),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings().schedules).toEqual([])
})

it("keeps legacy parseable timestamps readable when only the prompt changes", async () => {
  const old = {
    id: "legacy",
    name: "legacy",
    runAt: "2999-01-01T09:00:00",
    prompt: "old",
    enabled: true,
  }
  const store = new MemoryLeucoStore({ schedules: [old] })
  await manageSettings(
    parseArguments(["config", "set", "schedules", JSON.stringify([{ ...old, prompt: "updated" }])]),
    store,
  )
  expect(store.loadSettings().schedules[0]).toEqual({ ...old, prompt: "updated" })
})
it("rejects retiming an existing schedule to an ambiguous local timestamp", async () => {
  const old = {
    id: "one",
    name: "one",
    runAt: "2999-01-01T09:00:00Z",
    prompt: "old",
    enabled: true,
  }
  const store = new MemoryLeucoStore({ schedules: [old] })
  await expect(
    manageSettings(
      parseArguments([
        "config",
        "set",
        "schedules",
        JSON.stringify([{ ...old, runAt: "2999-01-01T09:00:00" }]),
      ]),
      store,
    ),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(store.loadSettings().schedules).toEqual([old])
})
