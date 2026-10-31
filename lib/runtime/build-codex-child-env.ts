type Props = { env: NodeJS.ProcessEnv; home: string }

const RESERVED_ENV_NAMES: ReadonlySet<string> = new Set([
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "LEUCO_SLACK_BOT_TOKEN",
  "LEUCO_SLACK_APP_TOKEN",
  "LEUCO_PROJECT_ID",
  "LEUCO_HOME",
])

export function buildCodexChildEnv(props: Props): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...props.env }
  for (const name of Object.keys(env))
    if (RESERVED_ENV_NAMES.has(name.toUpperCase())) delete env[name]
  env.LEUCO_HOME = props.home
  return env
}
