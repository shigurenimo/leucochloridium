import { statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { errorDetails } from "@/error-details"
import type { LeucoSettings } from "@/config/config-schema"
import type { LaunchConfiguration } from "@/maintenance/maintenance-schema"
import type { LeucoStore } from "@/storage/leuco-store"

type Props = { settings: LeucoSettings; launch: LaunchConfiguration | null; store: LeucoStore }

export function inspectLaunchEnvironment(props: Props) {
  const errors: string[] = []
  const failures: Array<{ phase: string; causes: ReturnType<typeof errorDetails> }> = []
  const launch = props.launch
  const cwd = launch?.cwd ?? props.settings.cwd ?? launch?.workingDirectory ?? process.cwd()
  const codex = Bun.which("codex", { PATH: process.env.PATH })
  const cli = Bun.which("leuco", { PATH: process.env.PATH })
  const soul = launch?.soul === undefined ? props.settings.soul : launch.soul
  const checks = { cwdExists: false, soulExists: soul === null }
  try {
    if (!statSync(cwd).isDirectory()) throw new Error("Working directory is not a directory")
    checks.cwdExists = true
  } catch (error) {
    errors.push(`Working directory is missing, unreadable or not a directory: ${cwd}`)
    failures.push({ phase: "cwd", causes: errorDetails(error) })
  }
  if (codex === null)
    errors.push("Codex executable is missing or not executable; install Codex or correct PATH")
  if (soul !== null) {
    try {
      props.store.readInstructions(resolve(cwd, soul))
      checks.soulExists = true
    } catch (error) {
      errors.push(
        `SOUL must be a readable UTF-8 regular file within the size limit: ${soul}; correct the file or pass --no-soul to leuco start or leuco restart`,
      )
      failures.push({ phase: "soul", causes: errorDetails(error) })
    }
  }
  if ((props.settings.slack !== null || props.settings.discord !== null) && cli === null)
    errors.push(
      "Slack/Discord replies require leuco on PATH. Run bun link in the Leuco checkout, include Bun's bin directory in PATH, then restart the daemon to inherit it. This check observes the invoking CLI's PATH.",
    )
  return {
    cwd,
    ...checks,
    codex,
    cli,
    codexHome: launch
      ? (launch.codexHome ?? join(homedir(), ".codex"))
      : (process.env.CODEX_HOME ?? join(homedir(), ".codex")),
    errors,
    failures,
  }
}
