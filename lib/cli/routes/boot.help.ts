export const help = `leuco boot — auto-start the daemon at login (macOS only)

usage:
  leuco boot install                  install ~/Library/LaunchAgents/io.leuco.daemon.plist and load it
  leuco boot uninstall                unload and delete the LaunchAgent plist
  leuco boot status                   print install + load state

The LaunchAgent runs \`bun <leuco-bin> run\` in the foreground; launchd
supervises it and restarts on crash. The current PATH and any LEUCO_*
env vars from the invoking shell are captured into the plist so codex
and friends resolve at boot.

Re-running \`install\` is safe: the existing agent is booted out, the
plist is rewritten with the latest paths / env, and bootstrapped again.

Run \`leuco boot <subcommand> -h\` for details on a specific subcommand.`
