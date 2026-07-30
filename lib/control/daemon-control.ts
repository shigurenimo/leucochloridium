export type DaemonThreadSummary = {
  project: string
  threadKey: string
  threadId: string
}

export type DaemonProjectSummary = {
  id: string
  name: string
  path: string
  enabled: boolean
  isRunning: boolean
}

export type DaemonControl = {
  getCwd(): string
  listProjects(): ReadonlyArray<DaemonProjectSummary>
  isCodexRunning(): boolean
  listConnectors(): ReadonlyArray<string>
  listThreads(): ReadonlyArray<DaemonThreadSummary>
  clearThread(threadKey: string): boolean
  reload(): Promise<void>
  restartProject(projectId: string): Promise<void>
  restartConnector(projectId: string, connectorName: string): Promise<void>
  resetProjectSession(projectId: string): Promise<void>
  pauseProject(projectId: string): Promise<void>
  resumeProject(projectId: string): Promise<void>
}
