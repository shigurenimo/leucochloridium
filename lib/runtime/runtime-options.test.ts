import { afterEach, expect, it, vi } from "vitest"
import { LeucoRuntime } from "@/runtime/runtime"
import type { LeucoRuntimeProps } from "@/runtime/runtime"
import { MemoryLeucoStore } from "@/storage/memory-leuco-store"
import { MemoryCodexClient } from "@/engine/codex/memory-codex-client"
import { MemoryCredentialStore } from "@/secrets/memory-credential-store"
import { buildRuntimeConnections } from "@/runtime/build-runtime-connections"

vi.mock("@/runtime/build-runtime-connections", () => ({ buildRuntimeConnections: vi.fn(() => []) }))

const active: LeucoRuntime[] = []
const reference = "6e6d9bcc-a07c-4c72-93f0-7eb651f9711d"
const credential = JSON.stringify({ botToken: "xoxb-options-test", appToken: "xapp-options-test" })

afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.stop()
  vi.clearAllMocks()
})

it("keeps the credential store selected when building the runtime", async () => {
  const selected = new MemoryCredentialStore()
  const other = new MemoryCredentialStore()
  await selected.set(reference, credential)
  await other.set(reference, credential)
  const options: LeucoRuntimeProps = {
    env: {},
    store: new MemoryLeucoStore({ slack: { credential: reference, ackMode: "off" } }),
    codex: new MemoryCodexClient(),
    connections: [],
    credentials: selected,
  }
  const runtime = LeucoRuntime.build(options)
  active.push(runtime)
  options.credentials = other
  await runtime.start()
  expect(selected.reads).toEqual([reference])
  expect(other.reads).toEqual([])
})

it.each([true, false])(
  "keeps connection selection while credentials are loading (explicit: %s)",
  async (explicit) => {
    const credentials = new MemoryCredentialStore()
    const pending = Promise.withResolvers<string | null>()
    vi.spyOn(credentials, "get").mockReturnValueOnce(pending.promise)
    const options: LeucoRuntimeProps = {
      env: {},
      store: new MemoryLeucoStore({ slack: { credential: reference, ackMode: "off" } }),
      codex: new MemoryCodexClient(),
      credentials,
      ...(explicit ? { connections: [] } : {}),
    }
    const runtime = LeucoRuntime.build(options)
    active.push(runtime)
    const starting = runtime.start()
    if (explicit) delete options.connections
    else options.connections = []
    pending.resolve(credential)
    await starting
    expect(buildRuntimeConnections).toHaveBeenCalledTimes(explicit ? 0 : 1)
  },
)
