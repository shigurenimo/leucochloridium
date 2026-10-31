import { expect, it } from "vitest"
import { z } from "zod"
import { getBoundedValidationIssues } from "@/get-bounded-validation-issues"

it("masks caller-known secrets before clipping validation paths and messages", () => {
  const secret = "synthetic-control-private-key"
  const failure = new z.ZodError([
    {
      code: "custom",
      path: [`${"p".repeat(180)}${secret}${"q".repeat(100)}`],
      message: `${"p".repeat(980)}${secret}${"q".repeat(100)}`,
    },
  ])
  const bounded = getBoundedValidationIssues(failure, [secret])
  expect(JSON.stringify(bounded)).not.toContain(secret.slice(0, 8))
  expect(bounded.issues[0]?.message.length).toBeLessThanOrEqual(1000)
  expect(bounded.issues[0]?.path[0]?.length).toBeLessThanOrEqual(200)
  expect(failure.issues[0]?.message).toContain(secret)
})

it("masks complete URL credentials before bounding validation paths and messages", () => {
  const url = `https://private-user:${"sensitive-password".repeat(100)}@host.example/path`
  const failure = new z.ZodError([{ code: "custom", path: [url], message: url }])
  expect(getBoundedValidationIssues(failure)).toEqual({
    issues: [
      {
        code: "custom",
        path: ["https://[redacted]@host.example/path"],
        message: "https://[redacted]@host.example/path",
      },
    ],
    omittedIssues: 0,
  })
})

it("marks shortened Unicode validation details without splitting characters", () => {
  const failure = new z.ZodError([
    { code: "custom", path: [`${"a".repeat(199)}😀tail`], message: `${"a".repeat(999)}😀tail` },
  ])
  const issue = getBoundedValidationIssues(failure).issues[0]!
  expect(issue.path[0]?.isWellFormed()).toBe(true)
  expect(issue.message.isWellFormed()).toBe(true)
  expect(issue.path[0]?.length).toBeLessThanOrEqual(200)
  expect(issue.message.length).toBeLessThanOrEqual(1000)
  expect(issue.path[0]).toContain("[truncated]")
  expect(issue.message).toContain("[truncated]")
})
