import { describe, expect, it } from "vitest"
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
    await expect(manageSettings(add, store)).rejects.toThrow()
    expect(store.loadSettings().schedules).toHaveLength(1)
    await manageSettings(parseArguments(["schedules", "remove", "daily"]), store)
    expect(store.loadSettings().schedules).toEqual([])
    expect(store.loadSettings().model).toBe("native-override")
  })
})
