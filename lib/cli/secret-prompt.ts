export abstract class SecretPrompt {
  abstract read(label: string): Promise<string>
}
