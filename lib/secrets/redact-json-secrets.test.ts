import { expect, it } from "vitest"
import { redactJsonSecrets } from "@/secrets/redact-json-secrets"
import { copyRedactedError } from "@/secrets/copy-redacted-error"
import { errorDetails } from "@/error-details"

it("masks escaped values and property names without corrupting JSON", () => {
  const secret = 'control"\\\nvalue'
  expect(
    redactJsonSecrets({ [secret]: `Bearer ${secret}`, intact: "日本語" }, [secret, ""]),
  ).toEqual({ "[redacted]": "Bearer [redacted]", intact: "日本語" })
})

it("keeps bounded aggregate diagnostics and OS codes without raw error references", () => {
  const original = Object.assign(new Error("private-control"), { code: "EACCES" })
  const aggregate = new AggregateError([original, new Error("cleanup private-control")], "failed", {
    cause: original,
  })
  const safe = copyRedactedError(aggregate, ["private-control"])
  const before = errorDetails(aggregate)
  const after = errorDetails(safe)
  expect(after.map((detail) => detail.code)).toEqual(before.map((detail) => detail.code))
  expect(after.map((detail) => detail.name)).toEqual(before.map((detail) => detail.name))
  expect(JSON.stringify(after)).not.toContain("private-control")
  expect(safe.cause).not.toBe(original)
  expect(after[2]?.message).toBe("cleanup [redacted]")
})

it("masks a complete secret before diagnostic length limits can leave a token fragment", () => {
  const secret = "control-0123456789-abcdefghijklmnopqrstuvwxyz"
  const original = Object.assign(new Error(`${"m".repeat(3988)}${secret}`), {
    name: `${"n".repeat(88)}${secret}`,
    stack: `${"s".repeat(7988)}${secret}`,
    code: `${"c".repeat(88)}${secret}`,
  })
  const safe = errorDetails(copyRedactedError(original, [secret]))[0]!
  for (const field of [safe.message, safe.stack, safe.code, safe.name]) {
    expect(field).not.toContain("control-")
    expect(field).toContain("[redacted]")
  }
})

it("returns an isolated JSON snapshot when no secret matched", () => {
  const original = { nested: { value: "retained" } }
  const snapshot = redactJsonSecrets(original, [])
  original.nested.value = "later mutation"
  expect(snapshot).toEqual({ nested: { value: "retained" } })
})

it("masks quoted WebSocket query credentials without corrupting JSON framing", () => {
  const value = {
    message:
      'before "wss://wss-primary.slack.com/link/?ticket=synthetic-socket-ticket&app_id=synthetic-app" after\nnext',
    other: "preserved",
  }
  expect(redactJsonSecrets(value, [])).toEqual({
    message: 'before "wss://wss-primary.slack.com/link/?[redacted]" after\nnext',
    other: "preserved",
  })
  expect(value.message).toContain("synthetic-socket-ticket")
})

it("masks contained escaped secrets in values and property names regardless of registration order", () => {
  const short = 'control"\\\nvalue'
  const full = `${short}-private-tail`
  const value = { [full]: `Bearer ${full} / ${short}`, intact: "日本語" }
  const expected = { "[redacted]": "Bearer [redacted] / [redacted]", intact: "日本語" }
  expect(redactJsonSecrets(value, [short, full])).toEqual(expected)
  expect(redactJsonSecrets(value, [full, short])).toEqual(expected)
})

it("masks URL credentials inside quoted JSON diagnostics without breaking framing", () => {
  expect(
    redactJsonSecrets(
      {
        message:
          'before "wss://private-user:private-password@host.example/path?ticket=private-ticket" after',
      },
      [],
    ),
  ).toEqual({ message: 'before "wss://[redacted]@host.example/path?[redacted]" after' })
})
