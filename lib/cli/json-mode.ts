export function jsonMode(args: readonly string[]): boolean {
  const end = args.indexOf("--")
  return args.slice(0, end < 0 ? undefined : end).includes("--json")
}
