type Props = {
  env: NodeJS.ProcessEnv
  codexHome: string
  projectId: string
}

/**
 * Give every project runtime Codex child an immutable-by-convention project identity.
 * The local Leuco CLI uses it to infer the current project and reject an
 * explicitly different project before any operation runs.
 */
export const buildCodexChildEnv = (props: Props): NodeJS.ProcessEnv => ({
  ...props.env,
  CODEX_HOME: props.codexHome,
  LEUCO_PROJECT_ID: props.projectId,
})
