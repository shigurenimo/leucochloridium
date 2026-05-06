export const help = `leuco update — update leuco to the latest published version

usage: leuco update [--check]

  --check       check the npm registry for a newer version without installing
  -h, --help    show this help

Runs \`bun add -g leuco@latest\` under the hood. Requires bun on PATH.

If the daemon is running when the install completes, it is restarted so the
freshly installed binary is loaded — \`bun add\` only swaps files on disk and
the long-lived daemon would otherwise keep executing the old code.`
