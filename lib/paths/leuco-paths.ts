import { homedir } from "node:os"
import { join } from "node:path"

type Props = {
  home?: string
}

/**
 * Single source of truth for every path under `~/.leuco/`. The directory tree
 * mirrors the URL tree the CLI walks (`projects/<p>/agents/<a>/...`); a
 * project's full state — including its agents, channels, and channel tokens —
 * lives in `<projectDir>/settings.json` (chmod 600), so adding a bot involves
 * one write rather than two. Cross-project (machine-wide) settings live in
 * `~/.leuco/settings.json`; per-project settings live in
 * `~/.leuco/projects/<p>/settings.json`. Same name at every scope.
 *
 *   ~/.leuco/
 *   ├── settings.json                                ← global settings
 *   ├── daemon/{pid,log}
 *   └── projects/
 *       └── <projectName>/
 *           ├── settings.json                        ← project config + secrets
 *           └── agents/
 *               └── <agentName>/
 *                   └── home/                        ← CODEX_HOME
 */
export class LeucoPaths {
  private readonly home: string
  private readonly base: string

  constructor(props: Props = {}) {
    this.home = props.home ?? homedir()
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

  /** Newline-delimited JSON stream of structured `LeucoEvent`s. */
  daemonEventLogPath(): string {
    return join(this.daemonDir(), "events.jsonl")
  }

  projectsRoot(): string {
    return join(this.base, "projects")
  }

  projectDir(projectName: string): string {
    return join(this.projectsRoot(), projectName)
  }

  projectSettingsPath(projectName: string): string {
    return join(this.projectDir(projectName), "settings.json")
  }

  agentsRoot(projectName: string): string {
    return join(this.projectDir(projectName), "agents")
  }

  agentDir(projectName: string, agentName: string): string {
    return join(this.agentsRoot(projectName), agentName)
  }

  /** CODEX_HOME for one tenant. */
  agentHome(projectName: string, agentName: string): string {
    return join(this.agentDir(projectName, agentName), "home")
  }

  /** macOS LaunchAgents directory under the user's Library. */
  launchAgentsDir(): string {
    return join(this.home, "Library", "LaunchAgents")
  }

  /** macOS launchd plist that auto-starts the daemon at login. */
  launchAgentPlistPath(): string {
    return join(this.launchAgentsDir(), "io.leuco.daemon.plist")
  }
}
