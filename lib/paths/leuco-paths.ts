import { homedir } from "node:os"
import { join } from "node:path"

type Props = {
  home?: string
}

/**
 * Single source of truth for every path under `~/.leuco/`. The directory tree
 * mirrors the URL tree the CLI walks (`projects/<id>/...`); a project's full
 * state — including its channels, channel tokens, and codex home — lives in
 * `<projectDir>/settings.json` (chmod 600) + `<projectDir>/.codex/`, so adding
 * a bot involves one write rather than two. Cross-project (machine-wide)
 * settings live in `~/.leuco/settings.json`; per-project settings live in
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
 *           ├── state.json                           ← runtime state (codexThreadId)
 *           └── .codex/                              ← CODEX_HOME
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

  /** CODEX_HOME for the project's single tenant. */
  projectHome(projectId: string): string {
    return join(this.projectDir(projectId), ".codex")
  }

  /** Mutable per-project runtime state (codex thread id, schedule lastFiredAt). */
  projectStatePath(projectId: string): string {
    return join(this.projectDir(projectId), "state.json")
  }

  /** @deprecated Pre-0.9 agents root. Used only by migration. */
  legacyAgentsRoot(projectId: string): string {
    return join(this.projectDir(projectId), "agents")
  }

  /** @deprecated Pre-0.9 agent home (home/ variant). Used only by migration. */
  legacyAgentHome(projectId: string, agentName: string): string {
    return join(this.legacyAgentsRoot(projectId), agentName, "home")
  }

  /** @deprecated Pre-0.9 agent home (.codex/ variant). Used only by migration. */
  legacyAgentCodex(projectId: string, agentName: string): string {
    return join(this.legacyAgentsRoot(projectId), agentName, ".codex")
  }

  /** @deprecated Pre-0.9 agent state. Used only by migration. */
  legacyAgentStatePath(projectId: string, agentName: string): string {
    return join(this.legacyAgentsRoot(projectId), agentName, "state.json")
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
