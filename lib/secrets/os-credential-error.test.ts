import { describe, expect, it } from "vitest"
import { osCredentialError } from "@/secrets/os-credential-error"
import { errorDetails } from "@/error-details"

describe("OS credential diagnostics", () => {
  it("keeps a native error code without exposing a secret in the OS exception", () => {
    const error = osCredentialError(
      "save",
      Object.assign(new Error("secret-value-must-stay-private"), { code: "EACCES" }),
    )
    expect(error.message).toContain("EACCES")
    expect(JSON.stringify(errorDetails(error))).not.toContain("secret-value-must-stay-private")
  })
  it("rejects secret-looking or freeform error codes", () => {
    expect(osCredentialError("read", { code: "xoxb-secret" }).message).toContain("unknown")
    expect(osCredentialError("delete", { code: -25293 }).message).toContain("-25293")
  })
})

it("does not expose a secondary exception from an OS code getter", () => {
  const failure = Object.defineProperty({}, "code", {
    get() {
      throw new Error("private-accessor-sentinel")
    },
  })
  expect(() => osCredentialError("read", failure)).not.toThrow()
  const safe = osCredentialError("read", failure)
  expect(safe.message).toContain("unknown")
  expect(JSON.stringify(errorDetails(safe))).not.toContain("private-accessor-sentinel")
})
it("does not invoke an OS code object's string conversion", () => {
  const code = {
    toString() {
      throw new Error("private-conversion-sentinel")
    },
  }
  expect(() => osCredentialError("save", { code })).not.toThrow()
  const safe = osCredentialError("save", { code })
  expect(safe.message).toContain("unknown")
  expect(JSON.stringify(errorDetails(safe))).not.toContain("private-conversion-sentinel")
})
it("contains an unreadable revoked OS error value", () => {
  const failure = Proxy.revocable({}, {})
  failure.revoke()
  expect(() => osCredentialError("delete", failure.proxy)).not.toThrow()
  expect(osCredentialError("delete", failure.proxy).message).toContain("unknown")
})
