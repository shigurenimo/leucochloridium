export abstract class CredentialStore {
  abstract get(name: string): Promise<string | null>
  abstract set(name: string, value: string): Promise<void>
  abstract delete(name: string): Promise<void>
}
