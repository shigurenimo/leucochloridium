import { homedir } from "node:os"
import { join } from "node:path"

type Props = {
  home?: string
}

/**
 * Single source of truth for every path under `~/.leuco/`. The directory tree
 * mirrors the URL tree the CLI walks (`projects/<id>/agents/<a>/...`); a
 * project's full state — including its agents, channels, and channel tokens —
 * lives in `<projectDir>/settings.json` (chmod 600), so adding a bot involves
 * one write rather than two. Cross-project (machine-wide) settings live in
 * `~/.leuco/settings.json`; per-project settings live in
 * `~/.leuco/projects/<id>/settings.json`.
 *
 * Project directories are keyed by UUID (`Project.id`) rather than `name`, so
 * the on-disk layout never moves when a user renames a project and same-name
 * projects pointing at different repos can coexist.
 *
 *   ~/.leuco/
 *   ├── settings.json                                ← global settings
 *   ├── daemon/{pid,log}
 *   └── projects/
 *       └── <projectId>/
 *           ├── settings.json                        ← project config + secrets
 *           └── agents/
 *               └── <agentName>/
 *                   └── .codex/                      ← CODEX_HOME
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

  projectDir(projectId: string): string {
    return join(this.projectsRoot(), projectId)
  }

  projectSettingsPath(projectId: string): string {
    return join(this.projectDir(projectId), "settings.json")
  }

  agentsRoot(projectId: string): string {
    return join(this.projectDir(projectId), "agents")
  }

  agentDir(projectId: string, agentName: string): string {
    return join(this.agentsRoot(projectId), agentName)
  }

  /** CODEX_HOME for one tenant. */
  agentHome(projectId: string, agentName: string): string {
    return join(this.agentDir(projectId, agentName), ".codex")
  }

  /** @deprecated Pre-0.9 path. Used only by the auto-migration in runtime. */
  legacyAgentHome(projectId: string, agentName: string): string {
    return join(this.agentDir(projectId, agentName), "home")
  }

  /**
   * Mutable per-agent runtime state (codex thread id, future per-entry
   * lastFiredAt, etc). Kept out of `settings.json` so the settings file
   * remains an idempotent, human-editable config surface — the daemon
   * writes here on every persisted thread without touching settings.
   */
  agentStatePath(projectId: string, agentName: string): string {
    return join(this.agentDir(projectId, agentName), "state.json")
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
   * The shared codex login lives at `~/.codex/auth.json`. Per-tenant
   * `CODEX_HOME` directories symlink to it so tenants share auth without
   * paying for a separate `codex login`. Routed through `LeucoPaths` so a
   * test-injected `home` overrides it the same way it overrides everything
   * else under `.leuco/`.
   */
  codexAuthPath(): string {
    return join(this.home, ".codex", "auth.json")
  }
}
