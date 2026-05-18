export const help = `leuco projects <p> — operations on a registered project

usage:
  leuco projects <p> remove [--cascade]            unregister this project
  leuco projects <p> rename <new>                  rename this project
  leuco projects <p> relocate <new-path>           move the repo dir + update path
  leuco projects <p> merge-into <dst>              move every agent to <dst>, drop <p>
  leuco projects <p> agents                        list agents in this project
  leuco projects <p> agents add <a>                add an agent to this project
  leuco projects <p> agents <a> ...                operate on a specific agent

Run \`leuco projects <p> <subcommand> -h\` for details on a specific subcommand.`
