import { readStdin } from "@/cli/utils/read-stdin"

/**
 * Token-flag semantics shared by `channels add` and `channels set-tokens`.
 *
 * Returns `null` when the flag is absent (caller decides default vs preserve),
 * the flag's literal value when given, or stdin contents when the value is `-`.
 */
export const resolveTokenFlag = async (
  value: string | boolean | undefined,
): Promise<string | null> => {
  if (typeof value !== "string") return null
  if (value === "-") return await readStdin()
  return value
}
