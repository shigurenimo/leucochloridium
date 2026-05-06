export const help = `leuco projects <p> agents <a> channels <c> — operations on a registered channel

usage:
  leuco projects <p> agents <a> channels <c> remove                            remove this channel
  leuco projects <p> agents <a> channels <c> rename <new>                      rename this channel
  leuco projects <p> agents <a> channels <c> start                             enable this channel
  leuco projects <p> agents <a> channels <c> stop                              disable this channel
  leuco projects <p> agents <a> channels <c> restart                           rebuild the parent tenant
  leuco projects <p> agents <a> channels <c> set-tokens [--bot-token <t>] [--app-token <t>]
                                                                               update Slack tokens (use \`-\` to read one from stdin)

Run \`leuco projects <p> agents <a> channels <c> <subcommand> -h\` for details on a specific subcommand.`
