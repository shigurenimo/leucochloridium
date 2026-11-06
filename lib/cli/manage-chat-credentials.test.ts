import { ClipboardReadError } from "@/clipboard/clipboard-read-error"
import { errorDetails } from "@/error-details"
import { describe, expect, it, vi } from "vitest"
import type { ChatProvider } from "@/cli/chat-providers"
import { manageChatCredentials } from "@/cli/manage-chat-credentials"
import type { LeucoSettings } from "@/config/config-schema"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { MemoryClipboard } from "@/clipboard/memory-clipboard"
import { loadDiscordCredentials } from "@/secrets/load-discord-credentials"

const previous = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
const concurrent = "16161616-1616-4161-8161-161616161616"

type ProviderCase = {
  provider: ChatProvider
  token: string
  stored: Record<string, string>
  rotated: Record<string, string>
  firstReply: Record<string, unknown>
  rotatedReply: Record<string, unknown>
  extra: Record<string, unknown>
  withReference(settings: LeucoSettings, credential: string): LeucoSettings
  withEditedReference(settings: LeucoSettings, credential: string): LeucoSettings
}

const cases: ProviderCase[] = [
  {
    provider: "slack",
    token: "xoxb-test-secret",
    stored: { botToken: "xoxb-old-secret", appToken: "xapp-old-secret" },
    rotated: { botToken: "xoxb-test-secret", appToken: "xapp-old-secret" },
    firstReply: {
      slack: "saved in OS credential store",
      saved: "bot",
      complete: false,
      missing: ["app"],
      restartRequired: true,
    },
    rotatedReply: {
      slack: "saved in OS credential store",
      saved: "bot",
      complete: true,
      missing: [],
      restartRequired: true,
    },
    extra: { ackMode: "always" },
    withReference: (settings, credential) => ({
      ...settings,
      slack: { credential, ackMode: "mention" },
    }),
    withEditedReference: (settings, credential) => ({
      ...settings,
      slack: { credential, ackMode: "always" },
    }),
  },
  {
    provider: "discord",
    token: "fake-discord-token.test-secret.signature",
    stored: { botToken: "fake-discord-token.old-secret.signature" },
    rotated: { botToken: "fake-discord-token.test-secret.signature" },
    firstReply: { discord: "saved in OS credential store", complete: true, restartRequired: true },
    rotatedReply: {
      discord: "saved in OS credential store",
      complete: true,
      restartRequired: true,
    },
    extra: { messageContent: false },
    withReference: (settings, credential) => ({
      ...settings,
      discord: { credential, messageContent: true },
    }),
    withEditedReference: (settings, credential) => ({
      ...settings,
      discord: { credential, messageContent: false },
    }),
  },
]

describe.each(cases)("$provider OS credentials", (testCase) => {
  const provider = testCase.provider
  function fixture() {
    return {
      provider,
      store: new MemoryLeucoStore(),
      credentials: new MemoryCredentialStore(),
      clipboard: new MemoryClipboard(testCase.token),
    }
  }
  function login(test: ReturnType<typeof fixture>, signal?: AbortSignal) {
    return manageChatCredentials({ ...test, action: "login", kind: "bot", signal })
  }
  function logout(test: ReturnType<typeof fixture>) {
    return manageChatCredentials({ ...test, action: "logout" })
  }
  async function withPrevious(test: ReturnType<typeof fixture>) {
    test.store.updateSettings((settings) => testCase.withReference(settings, previous))
    await test.credentials.set(previous, JSON.stringify(testCase.stored))
  }
  function settingOf(test: ReturnType<typeof fixture>) {
    return test.store.loadSettings()[provider]
  }

  it("saves only a reference in settings, leaving token values in the credential store", async () => {
    const test = fixture()
    const reply = await login(test)
    const reference = settingOf(test)?.credential
    if (reference === undefined) throw new Error("Expected a saved credential reference")
    expect(JSON.stringify([reply, test.store.loadSettings(), test.clipboard.reads])).not.toContain(
      "test-secret",
    )
    expect(JSON.parse(test.credentials.entries.get(reference)!)).toEqual({
      botToken: testCase.token,
    })
    expect(reply).toEqual(testCase.firstReply)
  })
  it("rolls back a new credential if settings cannot be saved", async () => {
    const test = fixture()
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("disk full")
    })
    await expect(login(test)).rejects.toThrow("disk full")
    expect(test.credentials.entries.size).toBe(0)
  })
  it("retains a newly referenced credential when settings were written before an error was reported", async () => {
    const test = fixture()
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      throw new Error("lock release failed after settings write")
    })
    await expect(login(test)).rejects.toThrow()
    const referenced = settingOf(test)?.credential
    expect(referenced).toBeTruthy()
    expect(referenced && test.credentials.entries.has(referenced)).toBe(true)
  })
  it("does not delete the existing OS credential if logout settings cannot be saved", async () => {
    const test = fixture()
    await withPrevious(test)
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("settings read-only")
    })
    await expect(logout(test)).rejects.toThrow()
    expect(settingOf(test)?.credential).toBe(previous)
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
    const error = await login(test).then(
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
      await withPrevious(test)
      const update = test.store.updateSettings.bind(test.store)
      vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
        update(transform)
        throw new Error("post-save failure")
      })
      if (cleanupFails)
        vi.spyOn(test.credentials, "delete").mockRejectedValue(
          new Error("previous cleanup failure"),
        )
      const failure = await login(test).then(
        () => null,
        (error: unknown) => error,
      )
      const referenced = settingOf(test)?.credential
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
    await withPrevious(test)
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      throw new Error("post-save failure")
    })
    await expect(logout(test)).rejects.toThrow(previous)
    expect(settingOf(test)).toBeNull()
    expect(test.credentials.entries.has(previous)).toBe(true)
  })
  it("disables the provider before reporting vault cleanup failure with a recoverable reference", async () => {
    const test = fixture()
    await withPrevious(test)
    vi.spyOn(test.credentials, "delete").mockRejectedValue(new Error("vault cleanup failed"))
    const failure = await logout(test).then(
      () => null,
      (error: unknown) => error,
    )
    expect(settingOf(test)).toBeNull()
    expect(test.credentials.entries.has(previous)).toBe(true)
    expect(String(failure)).toContain(previous)
    expect(String(failure)).not.toContain("old-secret")
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
    "invalid",
    "not-json xoxb-private-value",
    "private value with spaces",
    "a".repeat(9000),
    JSON.stringify({ botToken: "xoxb-test-secret" }),
    JSON.stringify({
      botToken: "xoxb-test-secret",
      appToken: "xapp-test-secret",
      unexpected: true,
    }),
  ])("rejects wrapped JSON and invalid clipboard data without leaking it", async (contents) => {
    const test = fixture()
    const failure = await manageChatCredentials({
      ...test,
      action: "login",
      kind: "bot",
      clipboard: new MemoryClipboard(contents),
    }).then(
      () => null,
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: "NEEDS_HUMAN" })
    expect(String(failure)).not.toContain(contents)
    expect(String(failure)).not.toContain("private-value")
    expect(String(failure)).not.toContain("test-secret")
    expect(test.credentials.entries.size).toBe(0)
    expect(settingOf(test)).toBeNull()
  })
  it("does not touch the clipboard when logging out", async () => {
    const test = fixture()
    await logout(test)
    expect(test.clipboard.reads).toBe(0)
  })
  it("does not write credentials when the deadline expired during clipboard access", async () => {
    const test = fixture()
    const controller = new AbortController()
    vi.spyOn(test.clipboard, "read").mockImplementation(async () => {
      controller.abort()
      return testCase.token
    })
    await expect(login(test, controller.signal)).rejects.toThrow()
    expect(test.credentials.entries.size).toBe(0)
  })
  it("rotates credentials, preserves extra settings and deletes them on logout", async () => {
    const test = fixture()
    test.store.updateSettings((settings) => testCase.withEditedReference(settings, previous))
    await test.credentials.set(previous, JSON.stringify(testCase.stored))
    await login(test)
    expect(test.credentials.entries.has(previous)).toBe(false)
    expect(settingOf(test)).toMatchObject(testCase.extra)
    await expect(logout(test)).resolves.toEqual({ [provider]: "logged out" })
    expect(test.credentials.entries.size).toBe(0)
    expect(settingOf(test)).toBeNull()
  })
  it("preserves settings and rollback failures together", async () => {
    const test = fixture()
    vi.spyOn(test.store, "updateSettings").mockImplementation(() => {
      throw new Error("primary disk failure")
    })
    vi.spyOn(test.credentials, "delete").mockRejectedValue(new Error("rollback vault failure"))
    const failure = await login(test).then(
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
  it("removes an unreferenced credential when vault save acknowledgement fails after writing", async () => {
    const test = fixture()
    const set = test.credentials.set.bind(test.credentials)
    const primary = Object.assign(new Error("vault save acknowledgement failed"), { code: "EIO" })
    vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
      await set(name, value)
      throw primary
    })
    await expect(login(test)).rejects.toBe(primary)
    expect(test.credentials.entries.size).toBe(0)
    expect(settingOf(test)).toBeNull()
  })
  it("retains a recoverable reference and both causes when failed vault save cleanup also fails", async () => {
    const test = fixture()
    await withPrevious(test)
    const set = test.credentials.set.bind(test.credentials)
    vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
      await set(name, value)
      throw Object.assign(new Error("vault save acknowledgement failed"), { code: "EIO" })
    })
    vi.spyOn(test.credentials, "delete").mockRejectedValue(
      Object.assign(new Error("vault cleanup failed"), { code: "EACCES" }),
    )
    const failure = await login(test).catch((error: unknown) => error)
    const retained = [...test.credentials.entries.keys()].find((name) => name !== previous)
    if (retained === undefined) throw new Error("Expected a retained credential for recovery")
    expect(String(failure)).toContain(retained)
    expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
      expect.arrayContaining(["EIO", "EACCES"]),
    )
    expect(test.credentials.entries.has(previous)).toBe(true)
    expect(settingOf(test)?.credential).toBe(previous)
    expect(JSON.stringify(errorDetails(failure))).not.toContain("test-secret")
  })
  it.each([false, true])(
    "reports committed setup and recoverable references after previous deletion acknowledgement fails (deleted=%s)",
    async (deleted) => {
      const test = fixture()
      await withPrevious(test)
      const remove = test.credentials.delete.bind(test.credentials)
      vi.spyOn(test.credentials, "delete").mockImplementation(async (name) => {
        if (deleted) await remove(name)
        throw Object.assign(new Error("previous deletion acknowledgement failed"), {
          code: "EACCES",
        })
      })
      const failure = await login(test).catch((error: unknown) => error)
      const current = settingOf(test)?.credential
      if (current === undefined || current === previous)
        throw new Error("New credential was not referenced")
      expect(failure).toMatchObject({
        code: "STATE_UNCERTAIN",
        details: {
          phase: "credential-cleanup",
          credential: current,
          previousCredential: previous,
          ...testCase.rotatedReply,
          causes: [{ code: "EACCES" }],
        },
      })
      expect(JSON.parse(test.credentials.entries.get(current)!)).toEqual(testCase.rotated)
      expect(test.credentials.entries.has(previous)).toBe(!deleted)
      expect(test.credentials.delete).toHaveBeenCalledOnce()
      expect(JSON.stringify(errorDetails(failure))).not.toContain("test-secret")
    },
  )
  it("does not replace a credential reference changed while vault save was pending", async () => {
    const test = fixture()
    await withPrevious(test)
    await test.credentials.set(concurrent, JSON.stringify(testCase.stored))
    const set = test.credentials.set.bind(test.credentials)
    vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
      await set(name, value)
      test.store.updateSettings((settings) => testCase.withEditedReference(settings, concurrent))
    })
    const failure = await login(test).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "STATE_CONFLICT",
      details: { phase: "credential-reference" },
    })
    expect(settingOf(test)).toEqual({ credential: concurrent, ...testCase.extra })
    expect([...test.credentials.entries.keys()].sort()).toEqual([previous, concurrent].sort())
  })
  it("preserves an extra-setting edit when the credential reference has not changed", async () => {
    const test = fixture()
    await withPrevious(test)
    const set = test.credentials.set.bind(test.credentials)
    vi.spyOn(test.credentials, "set").mockImplementation(async (name, value) => {
      await set(name, value)
      test.store.updateSettings((settings) => testCase.withEditedReference(settings, previous))
    })
    await login(test)
    expect(settingOf(test)).toMatchObject(testCase.extra)
    expect(test.credentials.entries.has(previous)).toBe(false)
  })
  it("does not clear a reference changed before logout acquires the settings update", async () => {
    const test = fixture()
    await withPrevious(test)
    await test.credentials.set(concurrent, JSON.stringify(testCase.stored))
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update((settings) => testCase.withEditedReference(settings, concurrent))
      update(transform)
    })
    const remove = vi.spyOn(test.credentials, "delete")
    const failure = await logout(test).catch((error: unknown) => error)
    expect(errorDetails(failure).map((cause) => cause.code)).toContain("STATE_CONFLICT")
    expect(settingOf(test)).toEqual({ credential: concurrent, ...testCase.extra })
    expect([...test.credentials.entries.keys()].sort()).toEqual([previous, concurrent].sort())
    expect(remove).not.toHaveBeenCalled()
  })
  it.each(["restored", "unreadable"])(
    "preserves old credentials when post-save settings are %s",
    async (mode) => {
      const test = fixture()
      await withPrevious(test)
      const update = test.store.updateSettings.bind(test.store)
      const load = test.store.loadSettings.bind(test.store)
      vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
        update(transform)
        if (mode === "restored")
          update((settings) => testCase.withEditedReference(settings, previous))
        else
          vi.spyOn(test.store, "loadSettings").mockImplementation(() => {
            throw Object.assign(new Error("cannot confirm saved settings"), { code: "EACCES" })
          })
      })
      const remove = vi.spyOn(test.credentials, "delete")
      const failure = await login(test).catch((error: unknown) => error)
      expect(failure).toMatchObject({
        code: "STATE_UNCERTAIN",
        details: { phase: "credential-cleanup", previousCredential: previous },
      })
      expect(test.credentials.entries.has(previous)).toBe(true)
      expect(test.credentials.entries.size).toBe(2)
      expect(remove).not.toHaveBeenCalled()
      expect(load()[provider]?.credential === previous).toBe(mode === "restored")
    },
  )
  it("does not delete a credential re-referenced after logout settings were saved", async () => {
    const test = fixture()
    await withPrevious(test)
    const update = test.store.updateSettings.bind(test.store)
    vi.spyOn(test.store, "updateSettings").mockImplementation((transform) => {
      update(transform)
      update((settings) => testCase.withEditedReference(settings, previous))
    })
    const remove = vi.spyOn(test.credentials, "delete")
    const failure = await logout(test).catch((error: unknown) => error)
    expect(errorDetails(failure).map((cause) => cause.code)).toContain("STATE_CONFLICT")
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
      const result = await login(test).catch((error: unknown) => error)
      expect(result).toMatchObject({ code: "NEEDS_HUMAN", details: { code: "UNAVAILABLE" } })
      expect(JSON.stringify(errorDetails(result))).not.toContain(
        "private-clipboard-diagnostic-sentinel",
      )
      expect(set).not.toHaveBeenCalled()
      expect(settingOf(test)).toBeNull()
    },
  )
  it("rejects plaintext token settings instead of silently persisting them", () => {
    const test = fixture()
    expect(() =>
      test.store.updateSettings((settings) => ({
        ...testCase.withReference(settings, previous),
        [provider]: { ...testCase.withReference(settings, previous)[provider], botToken: "x" },
      })),
    ).toThrow()
    expect(settingOf(test)).toBeNull()
  })
})

it.each(["bot", "app"])(
  "saves each Slack token separately, starting with %s, without losing the other",
  async (first) => {
    const store = new MemoryLeucoStore()
    const credentials = new MemoryCredentialStore()
    const second = first === "bot" ? "app" : "bot"
    const tokens: Record<string, string> = { bot: "xoxb-test-secret", app: "xapp-test-secret" }
    const initial = await manageChatCredentials({
      store,
      credentials,
      provider: "slack",
      action: "login",
      kind: first,
      clipboard: new MemoryClipboard(tokens[first]!),
    })
    expect(initial).toMatchObject({ saved: first, complete: false, missing: [second] })
    const completed = await manageChatCredentials({
      store,
      credentials,
      provider: "slack",
      action: "login",
      kind: second,
      clipboard: new MemoryClipboard(tokens[second]!),
    })
    expect(completed).toMatchObject({ saved: second, complete: true, missing: [] })
    expect(credentials.entries.size).toBe(1)
    expect(JSON.parse(credentials.entries.get(store.loadSettings().slack!.credential)!)).toEqual({
      botToken: tokens.bot,
      appToken: tokens.app,
    })
  },
)

it("rejects a token kind the provider does not store before reading the clipboard", async () => {
  const clipboard = new MemoryClipboard("fake-discord-token.test-secret.signature")
  await expect(
    manageChatCredentials({
      store: new MemoryLeucoStore(),
      credentials: new MemoryCredentialStore(),
      provider: "discord",
      action: "login",
      kind: "app",
      clipboard,
    }),
  ).rejects.toMatchObject({ code: "USAGE" })
  expect(clipboard.reads).toBe(0)
})

it("saves a Discord token the runtime loader accepts and fails closed for invalid entries", async () => {
  const store = new MemoryLeucoStore()
  const credentials = new MemoryCredentialStore()
  const token = "fake-discord-token.test-secret.signature"
  await manageChatCredentials({
    store,
    credentials,
    provider: "discord",
    action: "login",
    kind: "bot",
    clipboard: new MemoryClipboard(token),
  })
  expect(
    await loadDiscordCredentials(credentials, store.loadSettings().discord!.credential),
  ).toEqual({ botToken: token })
  await expect(loadDiscordCredentials(credentials, "missing")).rejects.toThrow("missing or invalid")
  await credentials.set("bad", '{"botToken":"secret"}')
  await expect(loadDiscordCredentials(credentials, "bad")).rejects.toThrow("missing or invalid")
})
