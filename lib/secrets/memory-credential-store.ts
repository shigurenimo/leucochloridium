import { CredentialStore } from "@/secrets/credential-store"

export class MemoryCredentialStore extends CredentialStore {
  readonly entries = new Map<string, string>()
  readonly reads: string[] = []
  async get(name: string): Promise<string | null> {
    this.reads.push(name)
    return this.entries.get(name) ?? null
  }
  async set(name: string, value: string): Promise<void> {
    this.entries.set(name, value)
  }
  async delete(name: string): Promise<void> {
    this.entries.delete(name)
  }
}
