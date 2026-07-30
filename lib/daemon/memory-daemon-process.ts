import { DaemonProcessPort } from "@/daemon/daemon-process-port"

type SignalCall = {
  pid: number
  signal: NodeJS.Signals
}

type Props = {
  commands?: ReadonlyArray<{ pid: number; command: string }>
  identities?: ReadonlyArray<{ pid: number; identity: string }>
  liveLegacyPids?: ReadonlyArray<number>
  onSignal?: (call: SignalCall, process: MemoryDaemonProcess) => boolean
}

export class MemoryDaemonProcess extends DaemonProcessPort {
  readonly signals: SignalCall[] = []
  readonly sleeps: number[] = []
  private readonly commands = new Map<number, string>()
  private readonly identities = new Map<number, string>()
  private readonly liveLegacyPids = new Set<number>()
  private clockMs = 0

  constructor(private readonly props: Props = {}) {
    super()
    for (const entry of props.commands ?? []) {
      this.commands.set(entry.pid, entry.command)
    }
    for (const entry of props.identities ?? []) {
      this.identities.set(entry.pid, entry.identity)
    }
    for (const pid of props.liveLegacyPids ?? []) {
      this.liveLegacyPids.add(pid)
    }
  }

  getCommand(pid: number): string | null {
    return this.commands.get(pid) ?? null
  }

  getIdentity(pid: number): string | null {
    return this.identities.get(pid) ?? null
  }

  isAlive(pid: number): boolean {
    return this.identities.has(pid) || this.liveLegacyPids.has(pid)
  }

  sendSignal(pid: number, signal: NodeJS.Signals): boolean {
    const call = { pid, signal }
    this.signals.push(call)
    if (this.props.onSignal) return this.props.onSignal(call, this)
    return this.isAlive(pid)
  }

  now(): number {
    return this.clockMs
  }

  sleep(durationMs: number): void {
    this.sleeps.push(durationMs)
    this.clockMs += durationMs
  }

  setIdentity(pid: number, identity: string | null): void {
    if (identity === null) {
      this.identities.delete(pid)
      return
    }
    this.identities.set(pid, identity)
  }

  setLegacyAlive(pid: number, isAlive: boolean): void {
    if (isAlive) {
      this.liveLegacyPids.add(pid)
      return
    }
    this.liveLegacyPids.delete(pid)
  }
}
