import { homedir } from "node:os"
import { join } from "node:path"

type Props = {
  home?: string
}

/**
 * Single source of truth for every path under `~/.leuco/`.
 *
 * All project registrations (including per-channel Slack tokens) live in the
 * unified `~/.leuco/settings.json` (chmod 600). Per-project runtime state
 * and codex home stay in UUID-keyed directories so renames are free and
 * same-name projects can coexist.
 *
 *   ~/.leuco/
 *   ├── settings.json           ← global config + projects array (chmod 600)
 *   ├── daemon/{pid,log}
 *   └── projects/
 *       └── <projectId>/
 *           ├── state.json      ← runtime state (codexThreadId)
 *           └── .codex/         ← CODEX_HOME
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

  /** @deprecated Used only by migration from per-project settings.json. */
  projectSettingsPath(projectId: string): string {
    return join(this.projectDir(projectId), "settings.json")
  }

  /** CODEX_HOME for the project's single tenant. */
  projectHome(projectId: string): string {
    return join(this.projectDir(projectId), ".codex")
  }

  /** @deprecated Used only by migration from per-project state.json. */
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
