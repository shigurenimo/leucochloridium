import { Clipboard } from "@/clipboard/clipboard"

export class MemoryClipboard extends Clipboard {
  reads = 0
  constructor(private readonly contents: string | Error) {
    super()
  }
  async read(): Promise<string> {
    this.reads += 1
    if (this.contents instanceof Error) throw this.contents
    return this.contents
  }
}
