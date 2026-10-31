import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { runCli } from "@/cli/run-cli"
import { errorDetails } from "@/error-details"
import type { LeucoState } from "@/config/config-schema"
const fixture = vi.hoisted(() => ({
  manage: vi.fn(),
  release: vi.fn(),
  output: vi.fn(),
  update: vi.fn(),
}))
vi.mock("@/cli/manage-slack-credentials", () => ({ manageSlackCredentials: fixture.manage }))
vi.mock("@/cli/write-cli-output", () => ({ writeCliOutput: fixture.output }))
vi.mock("@/clipboard/node-clipboard", () => ({ NodeClipboard: class {} }))
vi.mock("@/secrets/bun-credential-store", () => ({ BunCredentialStore: class {} }))
vi.mock("@/daemon/daemon-lease", () => ({
  readDaemonLease: () => null,
  isProcessAlive: () => false,
  acquireDaemonLease: () => ({ pid: 42, token: "synthetic-reservation-token" }),
  releaseDaemonLease: fixture.release,
}))
vi.mock("@/storage/node-leuco-store", async () => {
  const memory = await import("@/storage/memory-leuco-store")
  return {
    NodeLeucoStore: class extends memory.MemoryLeucoStore {
      constructor() {
        super()
      }
      ensureHome() {}
      override updateState(transform: (state: LeucoState) => LeucoState) {
        fixture.update()
        super.updateState(transform)
      }
    },
  }
})
beforeEach(() => {
  vi.stubGlobal("Bun", { version: "1.4.4", semver: { satisfies: () => true } })
  fixture.manage.mockReset().mockImplementation(async (props: { action: string }) =>
    props.action === "logout"
      ? { slack: "logged out" }
      : {
          slack: "saved in OS credential store",
          saved: "bot",
          complete: false,
          missing: ["app"],
          restartRequired: true,
        },
  )
  fixture.release.mockReset().mockReturnValue(true)
  fixture.output.mockReset()
  fixture.update.mockReset()
})
afterEach(() => vi.unstubAllGlobals())
it.each([
  ["slack", "login", "bot"],
  ["slack", "logout"],
])("does not output success before credential reservation cleanup (%s)", async (...words) => {
  fixture.release.mockImplementationOnce(() => {
    throw Object.assign(new Error("release failed"), { code: "EIO" })
  })
  const failure = await runCli([...words, "--json"]).catch((error: unknown) => error)
  expect(fixture.output).not.toHaveBeenCalled()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "reservation-release", operationCompleted: true },
  })
})
it("keeps credential and reservation-release failures together", async () => {
  fixture.manage.mockRejectedValueOnce(
    Object.assign(new Error("credential operation failed"), { code: "EACCES" }),
  )
  fixture.release.mockImplementationOnce(() => {
    throw Object.assign(new Error("release failed"), { code: "EIO" })
  })
  const failure = await runCli(["slack", "logout", "--json"]).catch((error: unknown) => error)
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EACCES", "EIO"]),
  )
  expect(fixture.output).not.toHaveBeenCalled()
})
it("keeps state-reset and reservation-release failures together", async () => {
  fixture.update.mockImplementationOnce(() => {
    throw Object.assign(new Error("state write failed"), { code: "EDQUOT" })
  })
  fixture.release.mockImplementationOnce(() => {
    throw Object.assign(new Error("release failed"), { code: "EIO" })
  })
  const failure = await runCli(["session", "reset", "--json"]).catch((error: unknown) => error)
  expect(errorDetails(failure).map((cause) => cause.code)).toEqual(
    expect.arrayContaining(["EDQUOT", "EIO"]),
  )
  expect(fixture.output).not.toHaveBeenCalled()
})
it("prints a credential result only after reservation release succeeded", async () => {
  await runCli(["slack", "login", "bot", "--json"])
  expect(fixture.release).toHaveBeenCalledOnce()
  expect(fixture.output).toHaveBeenCalledOnce()
  expect(fixture.release.mock.invocationCallOrder[0]!).toBeLessThan(
    fixture.output.mock.invocationCallOrder[0]!,
  )
})

it("preserves the original operation failure when reservation release succeeds", async () => {
  const primary = new Error("credential operation failed")
  fixture.manage.mockRejectedValueOnce(primary)
  await expect(runCli(["slack", "logout", "--json"])).rejects.toBe(primary)
  expect(fixture.release).toHaveBeenCalledOnce()
  expect(fixture.output).not.toHaveBeenCalled()
})
it("masks the reservation token in release failure diagnostics", async () => {
  fixture.release.mockImplementationOnce(() => {
    throw new Error("release synthetic-reservation-token failed")
  })
  const failure = await runCli(["session", "reset", "--json"]).catch((error: unknown) => error)
  expect(JSON.stringify({ failure, causes: errorDetails(failure) })).not.toContain(
    "synthetic-reservation-token",
  )
  expect(fixture.output).not.toHaveBeenCalled()
})

it("does not output success after ownership changes during a completed state update", async () => {
  fixture.release.mockReturnValueOnce(false)
  const failure = await runCli(["session", "reset", "--json"]).catch((error: unknown) => error)
  expect(fixture.update).toHaveBeenCalledOnce()
  expect(fixture.output).not.toHaveBeenCalled()
  expect(failure).toMatchObject({
    code: "STATE_UNCERTAIN",
    details: { phase: "reservation-release", operationCompleted: true },
  })
})

it.each([
  ["session", "reset"],
  ["config", "set", "model", '"cancelled-model"'],
  ["schedules", "add", "--name", "cancelled", "--run-at", "* * * * *", "--prompt", "cancelled"],
  ["slack", "login", "bot"],
  ["slack", "logout"],
])("does not start a pre-cancelled CLI operation %j", async (...args) => {
  const reason = new Error("caller cancelled before execution")
  await expect(runCli(args, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason)
  expect(fixture.update).not.toHaveBeenCalled()
  expect(fixture.manage).not.toHaveBeenCalled()
  expect(fixture.release).not.toHaveBeenCalled()
  expect(fixture.output).not.toHaveBeenCalled()
})
