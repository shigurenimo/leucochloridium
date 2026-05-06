export const help = `leuco config — read and write machine-wide settings

usage:
  leuco config list                     print every key in ~/.leuco/settings.json
  leuco config get <key>                print one key
  leuco config set <key> <value>        write one key (validated against the schema)

Recognised keys:
  keepAwake (boolean)    macOS: keep the system awake while leuco runs
                         (wraps the daemon launch with \`caffeinate -i\`).
                         Defaults to true. Restart the daemon to pick up
                         changes (\`leuco restart\`).

Run \`leuco config <subcommand> -h\` for details on a specific subcommand.`
