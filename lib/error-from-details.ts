import type { errorDetails } from "@/error-details"

export function errorFromDetails(
  details: ReadonlyArray<ReturnType<typeof errorDetails>[number]>,
): Error {
  return (
    details.reduceRight<Error | undefined>((cause, detail) => {
      const restored = new Error(detail.message, { cause })
      restored.name = detail.name
      if (detail.stack !== null) restored.stack = detail.stack
      if (detail.code !== null) Object.assign(restored, { code: detail.code })
      return restored
    }, undefined) ?? new Error("Unknown failure")
  )
}
