import type { DiagnosticOutput } from "@/diagnostic-output"
import { NodeDiagnosticOutput } from "@/node-diagnostic-output"
import { awaitBoundedCleanup } from "@/await-bounded-cleanup"
import { CliError } from "@/cli/cli-error"
import { errorDetails } from "@/error-details"
import { CLI_OUTPUT_TIMEOUTS_MS } from "@/cli/cli-output-limits"

type Props = { destination: "stdout" | "stderr"; output?: DiagnosticOutput }

export async function writeCliText(text: string, props: Props): Promise<void> {
  try {
    await awaitBoundedCleanup(
      (props.output ?? new NodeDiagnosticOutput(props.destination)).write(text),
      "CLI output delivery",
      CLI_OUTPUT_TIMEOUTS_MS[props.destination],
    )
  } catch (error) {
    const failure = new CliError(
      "STATE_UNCERTAIN",
      "CLI output delivery was not confirmed. Inspect current state before retrying the operation.",
      { phase: "output-flush", destination: props.destination, causes: errorDetails(error) },
    )
    failure.cause = error
    throw failure
  }
}
