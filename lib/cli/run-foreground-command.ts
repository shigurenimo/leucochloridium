import { launchOverrides } from "@/cli/launch-overrides"
import type { CliArguments } from "@/cli/parse-arguments"
import { runDaemon } from "@/daemon/run-daemon"

type Props = { home: string; parsed: CliArguments; requestId: string; signal?: AbortSignal }

export async function runForegroundCommand(props: Props) {
  await runDaemon({
    ...launchOverrides(props.parsed),
    home: props.home,
    ownsProcess: true,
    requestId: props.requestId,
    signal: props.signal,
  })
  return { stopped: true }
}
