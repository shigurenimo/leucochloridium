import { describe, expect, it } from "vitest"
import { toVerifiedLegacyDaemonPidLease } from "@/daemon/legacy-pid-lease/to-verified-legacy-daemon-pid-lease"

describe("toVerifiedLegacyDaemonPidLease", () => {
  it.each([
    "/Users/i/.bun/bin/bun /Users/i/leucochloridium/lib/index.ts run",
    "/opt/bun /home/me/.bun/install/global/node_modules/leuco/lib/index.ts run",
  ])("recognizes a Bun-hosted Leuco daemon command", (processCommand) => {
    expect(
      toVerifiedLegacyDaemonPidLease({
        pid: 40178,
        processCommand,
        processIdentity: "verified-process",
      }),
    ).toEqual({
      version: 1,
      pid: 40178,
      processIdentity: "verified-process",
    })
  })

  it.each([
    "/usr/bin/bun /tmp/unrelated/lib/index.ts run",
    "/Users/i/.bun/bin/bun /Users/i/leucochloridium/lib/index.ts status",
    "/bin/sleep 1000",
  ])("rejects an unrelated process command %s", (processCommand) => {
    expect(
      toVerifiedLegacyDaemonPidLease({
        pid: 40178,
        processCommand,
        processIdentity: "unrelated-process",
      }),
    ).toBeNull()
  })
})
