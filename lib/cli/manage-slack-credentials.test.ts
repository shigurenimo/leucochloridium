import { describe, expect, it, vi } from "vitest"
import { manageSlackCredentials } from "@/cli/manage-slack-credentials"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemorySecretPrompt } from "@/cli/memory-secret-prompt"

const previous = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
function fixture() {
  return {
    store: new MemoryLeucoStore(),
    credentials: new MemoryCredentialStore(),
    prompt: new MemorySecretPrompt(["xoxb-test-secret", "xapp-test-secret"]),
  }
}

describe("OS Slack credentials", () => {
  it("saves only a reference in settings, leaving token values in the credential store", async () => {
    const test = fixture()
    const reply = await manageSlackCredentials({ action: "login", ...test })
    const settings = test.store.loadSettings()
    expect(settings.slack?.credential).toBeTruthy()
    expect(JSON.stringify([reply, settings, test.prompt.labels])).not.toContain("test-secret")
    expect(JSON.parse(test.credentials.entries.get(settings.slack!.credential)!)).toEqual({
      botToken: "xoxb-test-secret",
      appToken: "xapp-test-secret",
    })
  })
  it("rolls back a new credential if settings cannot be saved", async () => {
    const test = fixture()
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("disk full")
    })
    await expect(manageSlackCredentials({ action: "login", ...test })).rejects.toThrow("disk full")
    expect(test.credentials.entries.size).toBe(0)
  })
  it("does not save partial input when the second prompt is cancelled", async () => {
    const test = fixture()
    await expect(
      manageSlackCredentials({
        action: "login",
        ...test,
        prompt: new MemorySecretPrompt(["first-secret"]),
      }),
    ).rejects.toThrow("cancelled")
    expect(test.credentials.entries.size).toBe(0)
    expect(test.store.loadSettings().slack).toBeNull()
  })
  it("rotates credentials and preserves ack configuration", async () => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "off" },
    }))
    await test.credentials.set(previous, "old-secret")
    await manageSlackCredentials({ action: "login", ...test })
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
})
