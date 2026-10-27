import { CredentialStore } from "@/secrets/credential-store"

export class BunCredentialStore extends CredentialStore {
  async get(name: string): Promise<string | null> {
    try {
      return await Bun.secrets.get({ service: "leuco", name })
    } catch {
      throw new Error("Cannot read OS credentials. Unlock or enable your OS credential store.")
    }
  }
  async set(name: string, value: string): Promise<void> {
    if (!Bun.semver.satisfies(Bun.version, ">=1.4.4"))
      throw new Error("Bun 1.4.4 or newer is required for device-local credential storage.")
    try {
      await Bun.secrets.set({
        service: "leuco",
        name,
        value,
        persist: "local",
        allowUnrestrictedAccess: false,
      })
    } catch {
      throw new Error("Cannot save OS credentials. Unlock or enable your OS credential store.")
    }
  }
  async delete(name: string): Promise<void> {
    try {
      await Bun.secrets.delete({ service: "leuco", name })
    } catch {
      throw new Error("Cannot delete OS credentials. Unlock or enable your OS credential store.")
    }
  }
}
