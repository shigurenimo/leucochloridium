import { factory } from "@/cli/cli-factory"
import { readCliBody } from "@/cli/utils/read-cli-body"
import { resetProjectSession } from "@/cli/utils/reset-project-session"

const help = `leuco projects <p> session reset / start a fresh Codex session

usage / leuco projects <p> session reset [--force]

Clears the Codex thread id so the next turn starts a fresh Codex session.
Codex memories, auth, Slack tokens, project settings, and repository files are kept.
If the project is enabled, the tenant is restarted so the in-memory thread id is
also discarded.

options:
  --force / allow resetting the project from inside its own Codex session`

export const projectsSessionResetHandler = factory.createHandlers(async (c) => {
  const body = await readCliBody(c)
  return await resetProjectSession(c, body, {
    help,
    commandName: "session reset",
  })
})
