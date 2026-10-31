import { ClipboardReadError } from "@/clipboard/clipboard-read-error"
import { errorDetails } from "@/error-details"
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
  it("retains a newly referenced credential when settings were written before an error was reported", async () => {
    const test = fixture()
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      throw new Error("lock release failed after settings write")
    })
    await expect(
      manageSlackCredentials({ action: "login", kind: "bot", ...test }),
    ).rejects.toThrow()
    const referenced = test.store.loadSettings().slack?.credential
    expect(referenced).toBeTruthy()
    expect(referenced && test.credentials.entries.has(referenced)).toBe(true)
  })
  it("does not delete the existing OS credential if logout settings cannot be saved", async () => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "mention" },
    }))
    await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("settings read-only")
    })
    await expect(manageSlackCredentials({ action: "logout", ...test })).rejects.toThrow()
    expect(test.store.loadSettings().slack?.credential).toBe(previous)
    expect(test.credentials.entries.has(previous)).toBe(true)
  })
  it("retains new credentials when the saved reference cannot be inspected after failure", async () => {
    const test = fixture()
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      vi.spyOn(test.store, "loadSettings").mockImplementation(() => {
        throw new Error("settings inspection failed")
      })
      throw new Error("save acknowledgement failed")
    })
    const error = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).then(
      () => null,
      (failure: unknown) => failure,
    )
    expect(error).toBeInstanceOf(AggregateError)
    if (error instanceof AggregateError)
      expect(error.errors.map(String)).toEqual([
        "Error: save acknowledgement failed",
        "Error: settings inspection failed",
      ])
    expect(test.credentials.entries.size).toBe(1)
  })
  it.each([false, true])(
    "keeps the saved credential when previous cleanup fails=%s",
    async (cleanupFails) => {
      const test = fixture()
      test.store.updateSettings((settings) => ({
        ...settings,
        slack: { credential: previous, ackMode: "off" },
      }))
      await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
      const update = test.store.updateSettings.bind(test.store)
      vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
        update(transform)
        throw new Error("post-save failure")
      })
      if (cleanupFails)
        vi.spyOn(test.credentials, "delete").mockRejectedValue(
          new Error("previous cleanup failure"),
        )
      const failure = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).then(
        () => null,
        (error: unknown) => error,
      )
      const referenced = test.store.loadSettings().slack?.credential
      expect(referenced && test.credentials.entries.has(referenced)).toBe(true)
      expect(test.credentials.entries.has(previous)).toBe(cleanupFails)
      if (cleanupFails) {
        expect(failure).toBeInstanceOf(AggregateError)
        if (failure instanceof AggregateError)
          expect(failure.errors.map(String)).toEqual([
            "Error: post-save failure",
            "Error: previous cleanup failure",
          ])
      }
    },
  )
  it("retains the old credential if logout settings were saved before an error", async () => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "mention" },
    }))
    await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      throw new Error("post-save failure")
    })
    await expect(manageSlackCredentials({ action: "logout", ...test })).rejects.toThrow(previous)
    expect(test.store.loadSettings().slack).toBeNull()
    expect(test.credentials.entries.has(previous)).toBe(true)
  })
  it("disables Slack before reporting vault cleanup failure with a recoverable reference", async () => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "mention" },
    }))
    await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
    vi.spyOn(test.credentials, "delete").mockRejectedValue(new Error("vault cleanup failed"))
    const failure = await manageSlackCredentials({ action: "logout", ...test }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(test.store.loadSettings().slack).toBeNull()
    expect(test.credentials.entries.has(previous)).toBe(true)
    expect(String(failure)).toContain(previous)
    expect(String(failure)).not.toContain("xoxb-old-secret")
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: {
        phase: "credential-cleanup",
        credential: null,
        previousCredential: previous,
        settingsSaved: true,
        deletionConfirmed: false,
      },
      cause: { message: "vault cleanup failed" },
    })
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

it("removes an unreferenced credential when vault save acknowledgement fails after writing", async () => {
  const test = fixture()
  const set = test.credentials.set.bind(test.credentials)
  const primary = Object.assign(new Error("vault save acknowledgement failed"), { code: "EIO" })
  vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
    await set(name, value)
    throw primary
  })
  await expect(manageSlackCredentials({ action: "login", kind: "bot", ...test })).rejects.toBe(
    primary,
  )
  expect(test.credentials.entries.size).toBe(0)
  expect(test.store.loadSettings().slack).toBeNull()
})
it("retains a recoverable reference and both causes when failed vault save cleanup also fails", async () => {
  const test = fixture()
  test.store.updateSettings((settings) => ({
    ...settings,
    slack: { credential: previous, ackMode: "mention" },
  }))
  await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
  const set = test.credentials.set.bind(test.credentials)
  vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
    await set(name, value)
    throw Object.assign(new Error("vault save acknowledgement failed"), { code: "EIO" })
  })
  vi.spyOn(test.credentials, "delete").mockRejectedValue(
    Object.assign(new Error("vault cleanup failed"), { code: "EACCES" }),
  )
  const failure = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).catch(
    (error: unknown) => error,
  )
  const retained = [...test.credentials.entries.keys()].find((name) => name !== previous)
  if (retained === undefined) throw new Error("Expected a retained credential for recovery")
  expect(String(failure)).toContain(retained)
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EIO", "EACCES"]),
  )
  expect(test.credentials.entries.has(previous)).toBe(true)
  expect(test.store.loadSettings().slack?.credential).toBe(previous)
  expect(JSON.stringify(errorDetails(failure))).not.toContain("xoxb-test-secret")
})

it.each([false, true])(
  "reports committed setup and recoverable references after previous deletion acknowledgement fails (deleted=%s)",
  async (deleted) => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "mention" },
    }))
    await test.credentials.set(
      previous,
      JSON.stringify({ botToken: "xoxb-old-secret", appToken: "xapp-old-secret" }),
    )
    const remove = test.credentials.delete.bind(test.credentials)
    vi.spyOn(test.credentials, "delete").mockImplementation(async (name) => {
      if (deleted) await remove(name)
      throw Object.assign(new Error("previous deletion acknowledgement failed"), { code: "EACCES" })
    })
    const failure = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).catch(
      (error: unknown) => error,
    )
    const current = test.store.loadSettings().slack?.credential
    if (current === undefined || current === previous)
      throw new Error("New credential was not referenced")
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: {
        phase: "credential-cleanup",
        credential: current,
        previousCredential: previous,
        saved: "bot",
        complete: true,
        missing: [],
        restartRequired: true,
        causes: [{ code: "EACCES" }],
      },
    })
    expect(JSON.parse(test.credentials.entries.get(current)!)).toEqual({
      botToken: "xoxb-test-secret",
      appToken: "xapp-old-secret",
    })
    expect(test.credentials.entries.has(previous)).toBe(!deleted)
    expect(test.credentials.delete).toHaveBeenCalledOnce()
    expect(JSON.stringify(errorDetails(failure))).not.toContain("xoxb-test-secret")
  },
)

it("does not replace a credential reference changed while vault save was pending", async () => {
  const test = fixture()
  const concurrent = "16161616-1616-4161-8161-161616161616"
  test.store.updateSettings((settings) => ({
    ...settings,
    slack: { credential: previous, ackMode: "mention" },
  }))
  await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
  await test.credentials.set(concurrent, JSON.stringify({ appToken: "xapp-concurrent-secret" }))
  const set = test.credentials.set.bind(test.credentials)
  vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
    await set(name, value)
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: concurrent, ackMode: "always" },
    }))
  })
  const failure = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).catch(
    (error: unknown) => error,
  )
  expect(failure).toMatchObject({
    code: "STATE_CONFLICT",
    details: { phase: "credential-reference" },
  })
  expect(test.store.loadSettings().slack).toEqual({ credential: concurrent, ackMode: "always" })
  expect([...test.credentials.entries.keys()].sort()).toEqual([previous, concurrent].sort())
})
it("preserves an ackMode edit when the credential reference has not changed", async () => {
  const test = fixture()
  test.store.updateSettings((settings) => ({
    ...settings,
    slack: { credential: previous, ackMode: "mention" },
  }))
  await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
  const set = test.credentials.set.bind(test.credentials)
  vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
    await set(name, value)
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "always" },
    }))
  })
  await manageSlackCredentials({ action: "login", kind: "bot", ...test })
  expect(test.store.loadSettings().slack?.ackMode).toBe("always")
  expect(test.credentials.entries.has(previous)).toBe(false)
})
it("does not clear a reference changed before logout acquires the settings update", async () => {
  const test = fixture()
  const concurrent = "16161616-1616-4161-8161-161616161616"
  test.store.updateSettings((settings) => ({
    ...settings,
    slack: { credential: previous, ackMode: "mention" },
  }))
  await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
  await test.credentials.set(concurrent, JSON.stringify({ appToken: "xapp-concurrent-secret" }))
  const update = test.store.updateSettings.bind(test.store)
  vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
    update((settings) => ({ ...settings, slack: { credential: concurrent, ackMode: "always" } }))
    update(transform)
  })
  const remove = vi.spyOn(test.credentials, "delete")
  const failure = await manageSlackCredentials({ action: "logout", ...test }).catch(
    (error: unknown) => error,
  )
  expect(errorDetails(failure).map((cause) => cause.code)).toContain("STATE_CONFLICT")
  expect(test.store.loadSettings().slack).toEqual({ credential: concurrent, ackMode: "always" })
  expect([...test.credentials.entries.keys()].sort()).toEqual([previous, concurrent].sort())
  expect(remove).not.toHaveBeenCalled()
})

it.each(["restored", "unreadable"])(
  "preserves old credentials when post-save settings are %s",
  async (mode) => {
    const test = fixture()
    test.store.updateSettings((settings) => ({
      ...settings,
      slack: { credential: previous, ackMode: "mention" },
    }))
    await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
    const update = test.store.updateSettings.bind(test.store)
    const load = test.store.loadSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      if (mode === "restored")
        update((settings) => ({ ...settings, slack: { credential: previous, ackMode: "always" } }))
      else
        vi.spyOn(test.store, "loadSettings").mockImplementation(() => {
          throw Object.assign(new Error("cannot confirm saved settings"), { code: "EACCES" })
        })
    })
    const remove = vi.spyOn(test.credentials, "delete")
    const failure = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).catch(
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({
      code: "STATE_UNCERTAIN",
      details: { phase: "credential-cleanup", previousCredential: previous },
    })
    expect(test.credentials.entries.has(previous)).toBe(true)
    expect(test.credentials.entries.size).toBe(2)
    expect(remove).not.toHaveBeenCalled()
    expect(load().slack?.credential === previous).toBe(mode === "restored")
  },
)
it("does not delete a credential re-referenced after logout settings were saved", async () => {
  const test = fixture()
  test.store.updateSettings((settings) => ({
    ...settings,
    slack: { credential: previous, ackMode: "mention" },
  }))
  await test.credentials.set(previous, JSON.stringify({ botToken: "xoxb-old-secret" }))
  const update = test.store.updateSettings.bind(test.store)
  vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
    update(transform)
    update((settings) => ({ ...settings, slack: { credential: previous, ackMode: "always" } }))
  })
  const remove = vi.spyOn(test.credentials, "delete")
  const failure = await manageSlackCredentials({ action: "logout", ...test }).catch(
    (error: unknown) => error,
  )
  expect(errorDetails(failure).map((cause) => cause.code)).toContain("STATE_CONFLICT")
  expect(String(failure)).not.toContain("Slack is disabled")
  expect(test.credentials.entries.has(previous)).toBe(true)
  expect(remove).not.toHaveBeenCalled()
})

it.each(["revoked", "message", "code"])(
  "contains unreadable clipboard failure metadata (%s) before saving",
  async (kind) => {
    const test = fixture()
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    const failure = new ClipboardReadError("FAILED", "read failed")
    if (kind !== "revoked")
      Object.defineProperty(failure, kind, {
        get() {
          throw new Error("private-clipboard-diagnostic-sentinel")
        },
      })
    vi.spyOn(test.clipboard, "read").mockRejectedValue(kind === "revoked" ? proxy.proxy : failure)
    const set = vi.spyOn(test.credentials, "set")
    const result = await manageSlackCredentials({ action: "login", kind: "bot", ...test }).catch(
      (error: unknown) => error,
    )
    expect(result).toMatchObject({ code: "NEEDS_HUMAN", details: { code: "UNAVAILABLE" } })
    expect(JSON.stringify(errorDetails(result))).not.toContain(
      "private-clipboard-diagnostic-sentinel",
    )
    expect(set).not.toHaveBeenCalled()
    expect(test.store.loadSettings().slack).toBeNull()
  },
)
