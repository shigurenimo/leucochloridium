import { describe, expect, it, vi } from "vitest"
import { manageDiscordCredentials } from "@/cli/manage-discord-credentials"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryClipboard } from "@/clipboard/memory-clipboard"
import { loadDiscordCredentials } from "@/secrets/load-discord-credentials"

const secret = "fake-discord-token.secret.signature"
function fixture() {
  return {
    store: new MemoryLeucoStore(),
    credentials: new MemoryCredentialStore(),
    clipboard: new MemoryClipboard(secret),
  }
}

describe("Discord credentials", () => {
  it("keeps the token in the OS store, rotates it, and deletes it on logout", async () => {
    const test = fixture()
    const reply = await manageDiscordCredentials({ ...test, action: "login" })
    const reference = test.store.loadSettings().discord?.credential
    expect(reference).toBeTruthy()
    expect(JSON.stringify([reply, test.store.loadSettings()])).not.toContain(secret)
    expect(await loadDiscordCredentials(test.credentials, reference!)).toEqual({ botToken: secret })
    await manageDiscordCredentials({ ...test, action: "login" })
    expect(test.credentials.entries.has(reference!)).toBe(false)
    expect(test.credentials.entries.size).toBe(1)
    const reads = test.clipboard.reads
    await manageDiscordCredentials({ ...test, action: "logout" })
    expect(test.clipboard.reads).toBe(reads)
    expect(test.credentials.entries.size).toBe(0)
    expect(test.store.loadSettings().discord).toBeNull()
  })
  it("rolls back the new secret on settings write failure", async () => {
    const test = fixture()
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("disk full")
    })
    await expect(manageDiscordCredentials({ ...test, action: "login" })).rejects.toThrow(
      "disk full",
    )
    expect(test.credentials.entries.size).toBe(0)
  })
  it.each(["invalid", '{"botToken":"secret"}', "private value with spaces", "a".repeat(9000)])(
    "rejects invalid clipboard data without leaking it",
    async (contents) => {
      const test = fixture()
      const failure = await manageDiscordCredentials({
        ...test,
        action: "login",
        clipboard: new MemoryClipboard(contents),
      }).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(String(failure)).not.toContain(contents)
      expect(test.credentials.entries.size).toBe(0)
    },
  )
  it("fails closed for missing or invalid saved credentials", async () => {
    const test = fixture()
    await expect(loadDiscordCredentials(test.credentials, "missing")).rejects.toThrow(
      "missing or invalid",
    )
    await test.credentials.set("bad", '{"botToken":"secret"}')
    await expect(loadDiscordCredentials(test.credentials, "bad")).rejects.toThrow(
      "missing or invalid",
    )
  })
})
