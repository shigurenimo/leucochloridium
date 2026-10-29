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
