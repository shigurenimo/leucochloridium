import { createInterface } from "node:readline"
import { runDaemon } from "@/daemon/run-daemon"
import { writeCliError } from "@/cli/write-cli-error"
import { randomUUID } from "node:crypto"

const requestId = randomUUID()
const commands = createInterface({ input: process.stdin })
commands.once("line", (mode) => {
  commands.close()
  const cause = new Error("injected root cause xoxb-reliability-secret")
  const failure = new Error("injected asynchronous failure", { cause })
  if (mode === "null") {
    void Promise.reject(null)
    return
  }
  if (mode === "throw")
    setTimeout(() => {
      throw failure
    }, 0)
  else void Promise.reject(failure)
})
try {
  await runDaemon({
    home: process.env.LEUCO_HOME!,
    cwd: process.cwd(),
    codexBin: process.env.LEUCO_VERIFY_CODEX!,
    quiet: true,
    ownsProcess: process.env.LEUCO_VERIFY_OWNS_PROCESS === "1",
    requestId,
  })
} catch (error) {
  writeCliError(error, ["run", "--foreground", "--json"], requestId)
}
