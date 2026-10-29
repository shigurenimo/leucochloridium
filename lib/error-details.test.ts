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
