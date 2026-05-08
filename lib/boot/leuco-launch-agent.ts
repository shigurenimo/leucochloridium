import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { LaunchctlBin } from "@/boot/launchctl-bin"
import type { LaunchctlPort } from "@/boot/launchctl-port"
import { toLaunchAgentPlist } from "@/boot/to-launch-agent-plist"
import { LeucoGlobalSettingsStore } from "@/global-settings/global-settings-store"
import { LeucoPaths } from "@/paths/leuco-paths"

const LABEL = "io.leuco.daemon"

type Props = {
  paths?: LeucoPaths
  launchctl?: LaunchctlPort
}

type InstallProps = {
  bunPath: string
  binPath: string
  workingDirectory: string
  envVars?: Record<string, string>
}

export type LaunchAgentInstallResult = {
  plistPath: string
  label: string
}

export type LaunchAgentUninstallResult = {
  plistPath: string
  label: string
  removed: boolean
}

export type LaunchAgentStatus = {
  label: string
  plistPath: string
  isInstalled: boolean
  isLoaded: boolean
}

/**
 * Manages the macOS LaunchAgent that auto-starts the leuco daemon at login.
 * Composes `LaunchctlPort` (subprocess IO) with the pure `toLaunchAgentPlist`
 * generator so the install/uninstall flow can be exercised end-to-end with an
 * in-memory port. Platform gating (darwin only) is the caller's job — this
 * class will happily write a plist anywhere.
 */
export class LeucoLaunchAgent {
  private readonly paths: LeucoPaths
  private readonly launchctl: LaunchctlPort

  constructor(props: Props = {}) {
    this.paths = props.paths ?? new LeucoPaths()
    this.launchctl = props.launchctl ?? new LaunchctlBin()
    Object.freeze(this)
  }

  getLabel(): string {
    return LABEL
  }

  getPlistPath(): string {
    return this.paths.launchAgentPlistPath()
  }

  async install(installProps: InstallProps): Promise<LaunchAgentInstallResult | Error> {
    const plistPath = this.paths.launchAgentPlistPath()
    const plistDir = dirname(plistPath)
    const daemonDir = this.paths.daemonDir()

    if (!existsSync(plistDir)) mkdirSync(plistDir, { recursive: true })
    if (!existsSync(daemonDir)) mkdirSync(daemonDir, { recursive: true })

    const settings = new LeucoGlobalSettingsStore({ paths: this.paths }).load()
    const keepAwake = settings instanceof Error ? true : settings.keepAwake

    const plist = toLaunchAgentPlist({
      label: LABEL,
      bunPath: installProps.bunPath,
      binPath: installProps.binPath,
      workingDirectory: installProps.workingDirectory,
      stdoutPath: join(daemonDir, "launchd.out.log"),
      stderrPath: join(daemonDir, "launchd.err.log"),
      envVars: installProps.envVars ?? {},
      keepAwake,
    })

    if (existsSync(plistPath)) {
      const bootedOut = await this.launchctl.bootout(plistPath)
      if (bootedOut instanceof Error) return bootedOut
    }

    try {
      writeFileSync(plistPath, plist)
    } catch (err) {
      if (err instanceof Error) return err
      return new Error(String(err))
    }

    const bootstrapped = await this.launchctl.bootstrap(plistPath)
    if (bootstrapped instanceof Error) return bootstrapped

    return { plistPath, label: LABEL }
  }

  async uninstall(): Promise<LaunchAgentUninstallResult | Error> {
    const plistPath = this.paths.launchAgentPlistPath()
    const isInstalled = existsSync(plistPath)

    if (isInstalled) {
      const bootedOut = await this.launchctl.bootout(plistPath)
      if (bootedOut instanceof Error) return bootedOut

      try {
        unlinkSync(plistPath)
      } catch (err) {
        if (err instanceof Error) return err
        return new Error(String(err))
      }
    }

    return { plistPath, label: LABEL, removed: isInstalled }
  }

  async status(): Promise<LaunchAgentStatus | Error> {
    const plistPath = this.paths.launchAgentPlistPath()
    const isInstalled = existsSync(plistPath)

    const loaded = await this.launchctl.isLoaded(LABEL)
    if (loaded instanceof Error) return loaded

    return { label: LABEL, plistPath, isInstalled, isLoaded: loaded }
  }
}
