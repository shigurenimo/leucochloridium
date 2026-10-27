import { createInterface } from "node:readline"
import { Writable } from "node:stream"
import { SecretPrompt } from "@/cli/secret-prompt"

export class NodeSecretPrompt extends SecretPrompt {
  async read(label: string): Promise<string> {
    if (!process.stdin.isTTY)
      throw new Error(
        "Run leuco slack login in an interactive terminal; tokens cannot be supplied as arguments or piped input.",
      )
    const silent = new Writable({
      write(_chunk, _encoding, done) {
        done()
      },
    })
    const terminal = createInterface({
      input: process.stdin,
      output: silent,
      terminal: true,
      historySize: 0,
    })
    process.stderr.write(label)
    try {
      return await new Promise<string>((resolve, reject) => {
        terminal.once("SIGINT", () => {
          terminal.close()
          reject(new Error("Credential entry cancelled"))
        })
        terminal.once("close", () => reject(new Error("Credential entry cancelled")))
        terminal.question("", (value) => resolve(value.trim()))
      })
    } finally {
      terminal.close()
      silent.destroy()
      process.stderr.write("\n")
    }
  }
}
