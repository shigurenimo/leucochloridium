import { osCredentialError } from "@/secrets/os-credential-error"
import { CredentialStore } from "@/secrets/credential-store"

export class BunCredentialStore extends CredentialStore {
  async get(name: string): Promise<string | null> {
    try {
      return await Bun.secrets.get({ service: "leuco", name })
    } catch (error) {
      throw osCredentialError("read", error)
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
    } catch (error) {
      throw osCredentialError("save", error)
    }
  }
  async delete(name: string): Promise<void> {
    try {
      await Bun.secrets.delete({ service: "leuco", name })
    } catch (error) {
      throw osCredentialError("delete", error)
    }
  }
}
