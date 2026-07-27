export abstract class DaemonProcessPort {
  abstract getIdentity(pid: number): string | null

  abstract isAlive(pid: number): boolean

  abstract sendSignal(pid: number, signal: NodeJS.Signals): boolean

  abstract now(): number

  abstract sleep(durationMs: number): void
}
