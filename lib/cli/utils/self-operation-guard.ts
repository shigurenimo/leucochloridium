export const isSelfAgentOperation = (projectName: string, agentName: string): boolean => {
  return process.env.LEUCO_PROJECT_NAME === projectName && process.env.LEUCO_AGENT_NAME === agentName
}

export const selfAgentOperationMessage = (operation: string, projectName: string, agentName: string) =>
  `refusing to ${operation} current agent ${projectName}/${agentName} from inside its own Codex turn; run it from an external shell`
