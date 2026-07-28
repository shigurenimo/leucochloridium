import { homedir } from "node:os"
import { join } from "node:path"

export type LeucoPathsProps = {
  home?: string
}

/**
 * Single source of truth for every path under `~/.leuco/`.
 *
 * Project registrations and connector settings live in the unified
 * `~/.leuco/settings.json` (chmod 600). Runtime state and Codex homes stay in
 * UUID-keyed project directories so renames are free and same-name projects
 * can coexist.
 *
 *   ~/.leuco/
 *   ├── settings.json           ← global config + projects array (chmod 600)
 *   ├── daemon/{pid,log}
 *   └── projects/
 *       └── <projectId>/
 *           ├── state.json      ← Codex threads + schedule runtime state
 *           └── .codex/         ← CODEX_HOME
 */
export class LeucoPaths {
  private readonly home: string
  private readonly base: string

  constructor(props: LeucoPathsProps = {}) {
    this.home = props.home ?? homedir()
    if (this.home === "") {
      // homedir() falls back to an empty string when neither HOME nor the
      // user database resolve. Joining `""` produces the relative path
      // `.leuco`, which would end up under whatever directory the daemon
      // happens to be in — invisible from the CLI's perspective. Fail loudly.
      throw new Error("LeucoPaths: cannot resolve home directory (HOME unset)")
    }
    this.base = join(this.home, ".leuco")
    Object.freeze(this)
  }

  getHome(): string {
    return this.home
  }

  root(): string {
    return this.base
  }

  /** Machine-wide daemon state — pid + log live here, not per-project. */
  daemonDir(): string {
    return join(this.base, "daemon")
  }

  daemonPidPath(): string {
    return join(this.daemonDir(), "pid")
  }

  daemonLogPath(): string {
    return join(this.daemonDir(), "log")
  }

  /** Cross-project (machine-wide) settings file. */
  settingsPath(): string {
    return join(this.base, "settings.json")
  }

  daemonEventLogPath(): string {
    return join(this.daemonDir(), "events.db")
  }

  projectsRoot(): string {
    return join(this.base, "projects")
  }

  projectDir(projectId: string): string {
    return join(this.projectsRoot(), projectId)
  }

  projectStatePath(projectId: string): string {
    return join(this.projectDir(projectId), "state.json")
  }

  /** CODEX_HOME for the project's single project runtime. */
  projectHome(projectId: string): string {
    return join(this.projectDir(projectId), ".codex")
  }

  /** macOS LaunchAgents directory under the user's Library. */
  launchAgentsDir(): string {
    return join(this.home, "Library", "LaunchAgents")
  }

  /** macOS launchd plist that auto-starts the daemon at login. */
  launchAgentPlistPath(): string {
    return join(this.launchAgentsDir(), "io.leuco.daemon.plist")
  }

  /**
   * The shared codex login lives at `~/.codex/auth.json`. Per-project
   * `CODEX_HOME` directories symlink to it so projects share auth without
   * paying for a separate `codex login`. Routed through `LeucoPaths` so a
   * test-injected `home` overrides it the same way it overrides everything
   * else under `.leuco/`.
   */
  codexAuthPath(): string {
    return join(this.home, ".codex", "auth.json")
  }
}
