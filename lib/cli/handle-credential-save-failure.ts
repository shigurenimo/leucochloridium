import type { CredentialStore } from "@/secrets/credential-store"
import type { LeucoStore } from "@/storage/leuco-store"

type Props = {
  store: LeucoStore
  credentials: CredentialStore
  credential: string
  previous: string | null
  failure: unknown
}

/** A failed acknowledgement does not prove that the settings write was rolled back. */
export async function handleCredentialSaveFailure(props: Props): Promise<never> {
  const observed = { referenced: false }
  try {
    observed.referenced = props.store.loadSettings().slack?.credential === props.credential
  } catch (inspection) {
    throw new AggregateError(
      [props.failure, inspection],
      `Could not verify settings after save failure; OS credential ${props.credential} was retained for recovery`,
      { cause: props.failure },
    )
  }
  if (observed.referenced) {
    if (props.previous !== null) {
      try {
        await props.credentials.delete(props.previous)
      } catch (cleanup) {
        throw new AggregateError(
          [props.failure, cleanup],
          `New credential is referenced and retained; previous OS credential ${props.previous} could not be removed`,
          { cause: props.failure },
        )
      }
    }
    throw new Error(
      "Settings reference the new OS credential; it was retained. The save acknowledgement or cleanup failed; inspect the cause before retrying",
      { cause: props.failure },
    )
  }
  try {
    await props.credentials.delete(props.credential)
  } catch (cleanup) {
    throw new AggregateError(
      [props.failure, cleanup],
      `Credential setup failed and new OS credential ${props.credential} could not be removed; inspect both causes`,
      { cause: props.failure },
    )
  }
  throw props.failure
}
