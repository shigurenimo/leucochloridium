import { afterEach, describe, expect, it, vi } from "vitest"
import { BunCredentialStore } from "@/secrets/bun-credential-store"
afterEach(() => vi.unstubAllGlobals())

describe("native credential adapter", () => {
  it("uses OS credentials with device-local persistence and restricted Keychain access", async () => {
    const secrets = {
      get: vi.fn(async () => "value"),
      set: vi.fn(async () => {}),
      delete: vi.fn(async () => true),
    }
    vi.stubGlobal("Bun", { secrets, version: "1.4.4", semver: { satisfies: () => true } })
    const store = new BunCredentialStore()
    await store.set("reference", "value")
    expect(secrets.set).toHaveBeenCalledWith({
      service: "leuco",
      name: "reference",
      value: "value",
      persist: "local",
      allowUnrestrictedAccess: false,
    })
    expect(await store.get("reference")).toBe("value")
    await store.delete("reference")
    expect(secrets.delete).toHaveBeenCalledWith({ service: "leuco", name: "reference" })
  })
  it("does not expose backend errors containing secret material", async () => {
    const fail = vi.fn(async () => {
      throw new Error("raw-secret-value")
    })
    vi.stubGlobal("Bun", {
      secrets: { get: fail, set: fail, delete: fail },
      version: "1.4.4",
      semver: { satisfies: () => true },
    })
    const store = new BunCredentialStore()
    for (const operation of [
      () => store.get("reference"),
      () => store.set("reference", "value"),
      () => store.delete("reference"),
    ]) {
      await expect(operation()).rejects.toThrow("OS credentials")
      await expect(operation()).rejects.not.toThrow("raw-secret")
    }
  })
  it("refuses older runtimes rather than silently using roaming persistence", async () => {
    const set = vi.fn()
    vi.stubGlobal("Bun", {
      version: "1.3.14",
      semver: { satisfies: () => false },
      secrets: { set },
    })
    await expect(new BunCredentialStore().set("reference", "value")).rejects.toThrow("Bun 1.4.4")
    expect(set).not.toHaveBeenCalled()
  })
})
