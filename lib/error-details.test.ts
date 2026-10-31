import { describe, expect, it } from "vitest"
import { errorDetails } from "@/error-details"

describe("bounded error diagnostics", () => {
  it("keeps codes, call sites and nested aggregate causes without cycling", () => {
    const root = Object.assign(new Error("root filesystem failure"), { code: "EACCES" })
    const secondary = new Error("cleanup failure", { cause: root })
    const aggregate = new AggregateError([root, secondary], "operation failed", { cause: root })
    root.cause = aggregate
    const causes = errorDetails(aggregate)
    expect(causes).toHaveLength(3)
    expect(causes.find((cause) => cause.code === "EACCES")?.stack).toContain(
      "error-details.test.ts",
    )
    expect(causes.map((cause) => cause.message)).toContain("cleanup failure")
    expect(
      errorDetails(
        new AggregateError(
          Array.from({ length: 20 }, () => new Error("many")),
          "root",
        ),
      ),
    ).toHaveLength(8)
  })
})

it("marks bounded diagnostic fields as truncated without splitting an emoji", () => {
  const failure = Object.assign(new Error(`${"m".repeat(3987)}😀tail that is too long`), {
    name: "n".repeat(1000),
    stack: "s".repeat(9000),
    code: "c".repeat(1000),
  })
  const diagnostic = errorDetails(failure)[0]!
  expect(diagnostic.name.length).toBeLessThanOrEqual(100)
  expect(diagnostic.message.length).toBeLessThanOrEqual(4000)
  expect(diagnostic.stack!.length).toBeLessThanOrEqual(8000)
  expect(diagnostic.code!.length).toBeLessThanOrEqual(100)
  for (const field of [diagnostic.name, diagnostic.message, diagnostic.stack, diagnostic.code]) {
    expect(field).toMatch(/ \[truncated\]$/)
    expect(field).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)
  }
})

it("retains sibling causes when a non-Error rejection cannot be printed", () => {
  const causes = errorDetails(
    new AggregateError([Object.create(null), new Error("cleanup failed")], "failed"),
  )
  expect(causes.map((cause) => cause.message)).toEqual([
    "failed",
    "[unprintable thrown value]",
    "cleanup failed",
  ])
})

it.each(["name", "stack", "code", "cause"])(
  "retains readable causes when error.%s throws",
  (field) => {
    const failure = new Error("original failure")
    Object.defineProperty(failure, field, {
      get: () => {
        throw new Error("private accessor failure")
      },
      configurable: true,
    })
    const aggregate = new AggregateError(
      [failure, new Error("cleanup failure")],
      "operation failed",
    )
    const diagnostics = errorDetails(aggregate)
    expect(diagnostics.map((cause) => cause.message)).toContain("original failure")
    expect(diagnostics.map((cause) => cause.message)).toContain("cleanup failure")
    expect(JSON.stringify(diagnostics)).toContain("[unreadable")
    expect(JSON.stringify(diagnostics)).not.toContain("private accessor failure")
  },
)
it("does not let a revoked thrown proxy prevent sibling diagnostics", () => {
  const revoked = Proxy.revocable({}, {})
  revoked.revoke()
  const diagnostics = errorDetails(
    new AggregateError([revoked.proxy, new Error("cleanup failure")], "operation failed"),
  )
  expect(diagnostics.map((cause) => cause.message)).toContain("[unprintable thrown value]")
  expect(diagnostics.map((cause) => cause.message)).toContain("cleanup failure")
})
it("marks an unreadable AggregateError.errors property", () => {
  const failure = new AggregateError([], "original aggregate failure")
  Object.defineProperty(failure, "errors", {
    get: () => {
      throw new Error("private accessor failure")
    },
  })
  const diagnostics = errorDetails(failure)
  expect(diagnostics[0]?.message).toBe("original aggregate failure")
  expect(JSON.stringify(diagnostics)).toContain("[unreadable aggregate causes]")
  expect(JSON.stringify(diagnostics)).not.toContain("private accessor failure")
})
it("continues past an unreadable aggregate cause entry", () => {
  const children = [new Error("hidden cause"), new Error("cleanup failure")]
  Object.defineProperty(children, "0", {
    get: () => {
      throw new Error("private accessor failure")
    },
  })
  const failure = new AggregateError([], "original aggregate failure")
  Object.assign(failure, { errors: children })
  const diagnostics = errorDetails(failure)
  expect(diagnostics.map((cause) => cause.message)).toContain("cleanup failure")
  expect(JSON.stringify(diagnostics)).toContain("[unreadable aggregate cause]")
})
it("contains a code value that cannot be printed", () => {
  const failure = Object.assign(new Error("original failure"), { code: Object.create(null) })
  expect(errorDetails(failure)[0]).toMatchObject({
    message: "original failure",
    code: "[unprintable diagnostic value]",
  })
})
