import { describe, expect, it } from "vitest"
import { withSyncCleanup } from "@/fs/with-sync-cleanup"

describe("preserved cleanup outcomes", () => {
  it("returns the original result only after cleanup succeeds", () => {
    const trace: string[] = []
    expect(
      withSyncCleanup(
        () => {
          trace.push("operation")
          return 42
        },
        () => {
          trace.push("cleanup")
        },
      ),
    ).toBe(42)
    expect(trace).toEqual(["operation", "cleanup"])
  })
  it("does not hide cleanup failure after successful work", () => {
    const cleanup = new Error("unlock failed")
    expect(() =>
      withSyncCleanup(
        () => 42,
        () => {
          throw cleanup
        },
      ),
    ).toThrow(cleanup)
  })
  it.each([new Error("primary failed"), null])(
    "preserves both failures including non-Error throws",
    (primary) => {
      const cleanup = new Error("close failed")
      const caught: { failure: unknown } = { failure: null }
      try {
        withSyncCleanup(
          () => {
            throw primary
          },
          () => {
            throw cleanup
          },
        )
      } catch (error) {
        caught.failure = error
      }
      expect(caught.failure).toBeInstanceOf(AggregateError)
      if (caught.failure instanceof AggregateError) {
        expect(caught.failure.errors).toEqual([primary, cleanup])
        expect(caught.failure.cause).toBe(primary)
      }
    },
  )
  it("preserves primary failure when cleanup succeeds", () => {
    const primary = new Error("write failed")
    expect(() =>
      withSyncCleanup(
        () => {
          throw primary
        },
        () => {},
      ),
    ).toThrow(primary)
  })
})
