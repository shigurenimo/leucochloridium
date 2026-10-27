import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { BunCredentialStore } from "@/secrets/bun-credential-store"

const store = new BunCredentialStore()
const name = `verify-${randomUUID()}`
const synthetic = "leuco-synthetic-test-value"
try {
  assert.equal(await store.get(name), null)
  await store.set(name, synthetic)
  assert.equal(await store.get(name), synthetic)
  await store.delete(name)
  assert.equal(await store.get(name), null)
  console.log(`OS credential round trip passed (${process.platform}); synthetic entry removed`)
} finally {
  await store.delete(name)
}
