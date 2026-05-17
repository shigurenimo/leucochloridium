export const help = `leuco projects <p> agents <a> — operations on a registered agent

usage:
  leuco projects <p> agents <a> remove [--cascade]    remove this agent
  leuco projects <p> agents <a> rename <new>          rename this agent
  leuco projects <p> agents <a> move-to <dst>         move this agent to another project
  leuco projects <p> agents <a> start                 enable this agent (daemon reload)
  leuco projects <p> agents <a> stop                  disable this agent (daemon reload)
  leuco projects <p> agents <a> restart               rebuild this agent's tenant
  leuco projects <p> agents <a> reset                 drop the codex thread id (memories preserved)
  leuco projects <p> agents <a> channels list         list channels under this agent
  leuco projects <p> agents <a> channels add slack    add a slack channel
  leuco projects <p> agents <a> channels <c> remove   remove a channel

Run \`leuco projects <p> agents <a> <subcommand> -h\` for details on a specific subcommand.`
