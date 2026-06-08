export const help = `leuco update / update leuco to the latest published version

usage / leuco update [--check]

options:
  --check / check the npm registry for a newer version without installing

Runs \`bun add -g leuco@latest\` under the hood. If the daemon is running when
the install completes, it is restarted so the freshly installed binary is loaded.`
