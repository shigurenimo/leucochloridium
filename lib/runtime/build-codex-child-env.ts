type Props = { env: NodeJS.ProcessEnv; home: string }

export function buildCodexChildEnv(props: Props): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...props.env, LEUCO_HOME: props.home }
  for (const name of [
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "LEUCO_SLACK_BOT_TOKEN",
    "LEUCO_SLACK_APP_TOKEN",
  ])
    delete env[name]
  delete env.LEUCO_PROJECT_ID
  return env
}
