import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LeucoLaunchAgent } from "@/boot/leuco-launch-agent"
import type { LaunchctlPort } from "@/boot/launchctl-port"
import { LeucoPaths } from "@/paths/leuco-paths"

type Call = { kind: "bootstrap" | "bootout" | "kickstart" | "isLoaded"; arg: string }

const fakeLaunchctl = (): {
  port: LaunchctlPort
  calls: Call[]
  setLoaded: (v: boolean) => void
} => {
  const calls: Call[] = []
  let loaded = false

  const port: LaunchctlPort = {
    async bootstrap(plistPath) {
      calls.push({ kind: "bootstrap", arg: plistPath })
      loaded = true
    },
    async bootout(plistPath) {
      calls.push({ kind: "bootout", arg: plistPath })
      loaded = false
    },
    async kickstart(label) {
      calls.push({ kind: "kickstart", arg: label })
    },
    async isLoaded(label) {
      calls.push({ kind: "isLoaded", arg: label })
      return loaded
    },
  }

  return {
    port,
    calls,
    setLoaded: (v: boolean) => {
      loaded = v
    },
  }
}

describe("LeucoLaunchAgent", () => {
  let home = ""
  let paths: LeucoPaths

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "leuco-boot-"))
    paths = new LeucoPaths({ home })
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  describe("install", () => {
    it("writes the plist and bootstraps it", async () => {
      const { port, calls } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      const result = await agent.install({
        bunPath: "/usr/local/bin/bun",
        binPath: "/Users/me/leuco/lib/index.ts",
        workingDirectory: "/Users/me/leuco",
      })

      expect(result).not.toBeInstanceOf(Error)
      const plistPath = paths.launchAgentPlistPath()
      expect(existsSync(plistPath)).toBe(true)

      const text = readFileSync(plistPath, "utf8")
      expect(text).toContain("<key>Label</key>")
      expect(text).toContain("<string>io.leuco.daemon</string>")
      expect(text).toContain("<string>/usr/local/bin/bun</string>")
      expect(text.split(paths.daemonLogPath())).toHaveLength(3)
      expect(statSync(plistPath).mode & 0o777).toBe(0o600)
      expect(statSync(paths.daemonDir()).mode & 0o777).toBe(0o700)

      expect(calls).toEqual([{ kind: "bootstrap", arg: plistPath }])
    })

    it("boots out an existing plist before re-bootstrapping", async () => {
      const { port, calls } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      await agent.install({
        bunPath: "/usr/local/bin/bun",
        binPath: "/x",
        workingDirectory: "/y",
      })
      chmodSync(paths.launchAgentPlistPath(), 0o644)
      calls.length = 0

      await agent.install({
        bunPath: "/usr/local/bin/bun",
        binPath: "/x",
        workingDirectory: "/y",
      })

      const plistPath = paths.launchAgentPlistPath()
      expect(calls).toEqual([
        { kind: "bootout", arg: plistPath },
        { kind: "bootstrap", arg: plistPath },
      ])
      expect(statSync(plistPath).mode & 0o777).toBe(0o600)
    })

    it("propagates launchctl bootstrap failures", async () => {
      const port: LaunchctlPort = {
        async bootstrap() {
          return new Error("nope")
        },
        async bootout() {},
        async kickstart() {},
        async isLoaded() {
          return false
        },
      }
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      const result = await agent.install({
        bunPath: "/bun",
        binPath: "/bin",
        workingDirectory: "/wd",
      })

      expect(result).toBeInstanceOf(Error)
    })
  })

  describe("uninstall", () => {
    it("boots out and removes the plist when present", async () => {
      const { port, calls } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      await agent.install({
        bunPath: "/bun",
        binPath: "/bin",
        workingDirectory: "/wd",
      })
      calls.length = 0

      const result = await agent.uninstall()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return

      expect(result.removed).toBe(true)
      const plistPath = paths.launchAgentPlistPath()
      expect(existsSync(plistPath)).toBe(false)
      expect(calls).toEqual([{ kind: "bootout", arg: plistPath }])
    })

    it("is a no-op when the plist is absent", async () => {
      const { port, calls } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      const result = await agent.uninstall()
      expect(result).not.toBeInstanceOf(Error)
      if (result instanceof Error) return

      expect(result.removed).toBe(false)
      expect(calls).toEqual([])
    })
  })

  describe("status", () => {
    it("reports installed=false / loaded=false on a clean machine", async () => {
      const { port } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      const status = await agent.status()
      expect(status).not.toBeInstanceOf(Error)
      if (status instanceof Error) return

      expect(status.isInstalled).toBe(false)
      expect(status.isLoaded).toBe(false)
    })

    it("reports installed=true / loaded=true after install", async () => {
      const { port } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      await agent.install({
        bunPath: "/bun",
        binPath: "/bin",
        workingDirectory: "/wd",
      })

      const status = await agent.status()
      if (status instanceof Error) throw status

      expect(status.isInstalled).toBe(true)
      expect(status.isLoaded).toBe(true)
    })
  })

  describe("kickstart", () => {
    it("starts the loaded job by label", async () => {
      const { port, calls } = fakeLaunchctl()
      const agent = new LeucoLaunchAgent({ paths, launchctl: port })

      const result = await agent.kickstart()

      expect(result).toBeUndefined()
      expect(calls).toEqual([{ kind: "kickstart", arg: "io.leuco.daemon" }])
    })
  })
})
