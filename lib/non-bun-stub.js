// Declare the public value so named imports reach the runtime compatibility error.
export const LeucoRuntime = (() => {
  throw new Error("leuco is Bun-only. Install Bun from https://bun.sh and import / run with Bun.")
})()
