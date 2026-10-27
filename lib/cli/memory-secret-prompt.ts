import { SecretPrompt } from "@/cli/secret-prompt"

export class MemorySecretPrompt extends SecretPrompt {
  readonly labels: string[] = []
  constructor(private readonly values: string[]) {
    super()
  }
  async read(label: string): Promise<string> {
    this.labels.push(label)
    const value = this.values.shift()
    if (value === undefined) throw new Error("Credential entry cancelled")
    return value
  }
}
