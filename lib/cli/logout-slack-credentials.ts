import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { assertSlackCredentialReference } from "@/cli/assert-slack-credential-reference"
import type { CredentialStore } from "@/secrets/credential-store"
import type { LeucoStore } from "@/storage/leuco-store"

type Props = { store: LeucoStore; credentials: CredentialStore; previous: string | null }

export async function logoutSlackCredentials(props: Props) {
  try {
    props.store.updateSettings((settings) => {
      assertSlackCredentialReference(settings, props.previous)
      return { ...settings, slack: null }
    })
  } catch (error) {
    throw new Error(
      `Slack settings could not be confirmed; OS credential ${props.previous ?? "(none)"} was not deleted. Inspect current settings before retrying`,
      { cause: error },
    )
  }
  if (props.previous !== null) {
    try {
      assertSlackCredentialReference(props.store.loadSettings(), null)
      await props.credentials.delete(props.previous)
    } catch (error) {
      const failure = new CliError(
        "STATE_UNCERTAIN",
        `Slack logout settings were saved, but deletion of OS credential ${props.previous} could not be confirmed. Inspect current settings and retain this reference for cleanup`,
        {
          phase: "credential-cleanup",
          credential: null,
          previousCredential: props.previous,
          settingsSaved: true,
          deletionConfirmed: false,
          causes: errorDetails(error),
        },
      )
      failure.cause = error
      throw failure
    }
  }
  return { slack: "logged out" }
}
