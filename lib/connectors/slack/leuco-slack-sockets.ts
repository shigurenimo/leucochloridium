export abstract class LeucoSlackSockets {
  abstract readonly WebSocket: (new (url: string | URL) => WebSocket) | null
  abstract close(): Promise<number>
}
