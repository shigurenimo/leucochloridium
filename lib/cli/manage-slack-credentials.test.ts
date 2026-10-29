import { describe, expect, it, vi } from "vitest"
import { manageSlackCredentials } from "@/cli/manage-slack-credentials"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryClipboard } from "@/clipboard/memory-clipboard"

const previous = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
function fixture() {
  return {
    store: new MemoryLeucoStore(),
    credentials: new MemoryCredentialStore(),
    clipboard: new MemoryClipboard("xoxb-test-secret"),
  }
}

describe("OS Slack credentials", () => {
  it("saves only a reference in settings, leaving token values in the credential store", async () => {
    const test = fixture()
    const reply = await manageSlackCredentials({ action: "login", kind: "bot", ...test })
    const settings = test.store.loadSettings()
    expect(settings.slack?.credential).toBeTruthy()
    expect(JSON.stringify([reply, settings, test.clipboard.reads])).not.toContain("test-secret")
    expect(JSON.parse(test.credentials.entries.get(settings.slack!.credential)!)).toEqual({
      botToken: "xoxb-test-secret",
    })
    expect(reply).toMatchObject({ saved: "bot", complete: false, missing: ["app"] })
  })
  it("rolls back a new credential if settings cannot be saved", async () => {
    const test = fixture()
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("disk full")
    })
    await expect(manageSlackCredentials({ action: "login", kind: "bot", ...test })).rejects.toThrow(
      "disk full",
    )
    expect(test.credentials.entries.size).toBe(0)
  })
  it.each([
    "not-json xoxb-private-value",
    JSON.stringify({ botToken: "xoxb-test-secret" }),
    JSON.stringify({
      botToken: "xoxb-test-secret",
      appToken: "xapp-test-secret",
      unexpected: true,
    }),
  ])("rejects wrapped JSON and invalid clipboard data", async (contents) => {
    const test = fixture()
    const failure = await manageSlackCredentials({
      action: "login",
      kind: "bot",
      ...test,
      clipboard: new MemoryClipboard(contents),
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain("private-value")
    expect(String(failure)).not.toContain("test-secret")
    expect(test.credentials.entries.size).toBe(0)
    expect(test.store.loadSettings().slack).toBeNull()
  })
  it("does not touch the clipboard when logging out", async () => {
    const test = fixture()
    await manageSlackCredentials({ action: "logout", ...test })
    expect(test.clipboard.reads).toBe(0)
  })
  it("does not write credentials when the deadline expired during clipboard access", async () => {
    const test = fixture()
    const controller = new AbortController()
    vi.spyOn(test.clipboard, "read").mockImplementation(async () => {
      controller.abort()
      return "xoxb-test-secret"
    })
    await expect(
      manageSlackCredentials({ action: "login", kind: "bot", ...test, signal: controller.signal }),
    ).rejects.toThrow()
    expect(test.credentials.entries.size).toBe(0)
  })
  it("rotates credentials and preserves ack configuration", async () => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "off" },
    }))
    await test.credentials.set(
      previous,
      JSON.stringify({ botToken: "xoxb-old-secret", appToken: "xapp-old-secret" }),
    )
    await manageSlackCredentials({ action: "login", kind: "bot", ...test })
    expect(test.credentials.entries.has(previous)).toBe(false)
    expect(test.store.loadSettings().slack?.ackMode).toBe("off")
    await manageSlackCredentials({ action: "logout", ...test })
    expect(test.credentials.entries.size).toBe(0)
    expect(test.store.loadSettings().slack).toBeNull()
  })
  it("rejects plaintext token settings instead of silently persisting them", () => {
    const test = fixture()
    expect(() =>
      test.store.updateSettings((settings) => ({
        ...settings,
        slack: { credential: previous, ackMode: "off", botToken: "plaintext" },
      })),
    ).toThrow()
    expect(test.store.loadSettings().slack).toBeNull()
  })
  it("preserves settings and rollback failures together", async () => {
    const test = fixture()
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("primary disk failure")
    })
    vi.spyOn(test.credentials, "delete").mockRejectedValue(new Error("rollback vault failure"))
    const failure = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(AggregateError)
    if (failure instanceof AggregateError)
      expect(failure.errors.map(String)).toEqual([
        "Error: primary disk failure",
        "Error: rollback vault failure",
      ])
  })
  it.each(["bot", "app"] satisfies Array<"bot" | "app">)(
    "saves each token separately, starting with %s, without losing the other",
    async (first) => {
      const test = fixture()
      const second = first === "bot" ? "app" : "bot"
      const tokens = { bot: "xoxb-test-secret", app: "xapp-test-secret" }
      const initial = await manageSlackCredentials({
        ...test,
        action: "login",
        kind: first,
        clipboard: new MemoryClipboard(tokens[first]),
      })
      expect(initial).toMatchObject({ saved: first, complete: false, missing: [second] })
      const completed = await manageSlackCredentials({
        ...test,
        action: "login",
        kind: second,
        clipboard: new MemoryClipboard(tokens[second]),
      })
      expect(completed).toMatchObject({ saved: second, complete: true, missing: [] })
      expect(test.credentials.entries.size).toBe(1)
      expect(
        JSON.parse(test.credentials.entries.get(test.store.loadSettings().slack!.credential)!),
      ).toEqual({ botToken: tokens.bot, appToken: tokens.app })
    },
  )
})
