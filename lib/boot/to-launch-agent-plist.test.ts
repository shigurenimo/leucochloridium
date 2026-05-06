import { describe, expect, it } from "vitest"
import { toLaunchAgentPlist } from "@/boot/to-launch-agent-plist"

describe("toLaunchAgentPlist", () => {
  const baseProps = {
    label: "io.leuco.daemon",
    bunPath: "/usr/local/bin/bun",
    binPath: "/Users/me/leuco/lib/index.ts",
    workingDirectory: "/Users/me/leuco",
    stdoutPath: "/Users/me/.leuco/daemon/launchd.out.log",
    stderrPath: "/Users/me/.leuco/daemon/launchd.err.log",
    envVars: {},
  }

  it("emits a plist with RunAtLoad and KeepAlive enabled", () => {
    const plist = toLaunchAgentPlist(baseProps)
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>")
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>")
  })

  it("invokes bun with the bin path and a `run` argument", () => {
    const plist = toLaunchAgentPlist(baseProps)
    expect(plist).toContain("<string>/usr/local/bin/bun</string>")
    expect(plist).toContain("<string>/Users/me/leuco/lib/index.ts</string>")
    expect(plist).toContain("<string>run</string>")
  })

  it("omits the EnvironmentVariables block when no env vars are supplied", () => {
    const plist = toLaunchAgentPlist(baseProps)
    expect(plist).not.toContain("EnvironmentVariables")
  })

  it("includes EnvironmentVariables when env vars are supplied", () => {
    const plist = toLaunchAgentPlist({
      ...baseProps,
      envVars: { LEUCO_PORT: "9743", PATH: "/opt/homebrew/bin:/usr/bin" },
    })
    expect(plist).toContain("<key>EnvironmentVariables</key>")
    expect(plist).toContain("<key>LEUCO_PORT</key>")
    expect(plist).toContain("<string>9743</string>")
    expect(plist).toContain("<key>PATH</key>")
  })

  it("escapes XML special characters in values", () => {
    const plist = toLaunchAgentPlist({
      ...baseProps,
      envVars: { WEIRD: 'a&b<c>"d' },
    })
    expect(plist).toContain("a&amp;b&lt;c&gt;&quot;d")
    expect(plist).not.toContain("a&b<c>")
  })

  it("uses the provided label", () => {
    const plist = toLaunchAgentPlist({ ...baseProps, label: "io.example.thing" })
    expect(plist).toContain("<string>io.example.thing</string>")
  })
})
