import { spawn } from "node:child_process"
import { Clipboard } from "@/clipboard/clipboard"
import { ClipboardReadError } from "@/clipboard/clipboard-read-error"

type Command = { executable: string; args: string[] }
const COMMANDS: Record<string, Command[]> = {
  darwin: [{ executable: "pbpaste", args: [] }],
  win32: ["powershell.exe", "pwsh.exe"].map((executable) => ({
    executable,
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); Get-Clipboard -Raw",
    ],
  })),
  linux: [
    { executable: "wl-paste", args: ["--no-newline"] },
    { executable: "xclip", args: ["-selection", "clipboard", "-o"] },
    { executable: "xsel", args: ["--clipboard", "--output"] },
  ],
}

/** Clipboard bytes stay in this process; no shell, stdin, command arguments or logs contain them. */
export class NodeClipboard extends Clipboard {
  async read(): Promise<string> {
    const command = (COMMANDS[process.platform] ?? []).find(
      (candidate) => Bun.which(candidate.executable, { PATH: process.env.PATH }) !== null,
    )
    if (!command)
      throw new ClipboardReadError(
        "UNAVAILABLE",
        "No desktop clipboard reader is available. macOS: pbpaste; Windows: PowerShell; Linux: wl-paste/xclip/xsel.",
      )
    const executable = Bun.which(command.executable, { PATH: process.env.PATH })!
    return new Promise((resolve, reject) => {
      const child = spawn(executable, command.args, { stdio: ["ignore", "pipe", "pipe"] })
      const output: Buffer[] = []
      const state = { bytes: 0, done: false }
      const finish = (error: ClipboardReadError | null): void => {
        if (state.done) return
        state.done = true
        clearTimeout(timer)
        child.stdout.destroy()
        child.stderr.destroy()
        if (error) {
          child.kill("SIGKILL")
          child.unref()
          reject(error)
          return
        }
        resolve(Buffer.concat(output).toString("utf8"))
      }
      const timer = setTimeout(
        () =>
          finish(
            new ClipboardReadError(
              "TIMEOUT",
              "Clipboard read exceeded 2 seconds; ensure the desktop clipboard is available and try again.",
            ),
          ),
        2000,
      )
      child.stdout.on("data", (chunk: Buffer) => {
        state.bytes += chunk.length
        if (state.bytes > 8192) {
          finish(
            new ClipboardReadError(
              "TOO_LARGE",
              "Clipboard data exceeds 8192 bytes; copy only one Slack token.",
            ),
          )
          return
        }
        output.push(chunk)
      })
      child.stderr.resume()
      child.stdout.on("error", () =>
        finish(
          new ClipboardReadError(
            "FAILED",
            "Clipboard reader output failed; no credential was registered.",
          ),
        ),
      )
      child.stderr.on("error", () =>
        finish(
          new ClipboardReadError(
            "FAILED",
            "Clipboard reader failed; no credential was registered.",
          ),
        ),
      )
      child.on("error", () =>
        finish(
          new ClipboardReadError(
            "FAILED",
            "Clipboard reader could not start; no credential was registered.",
          ),
        ),
      )
      child.on("close", (code) =>
        finish(
          code === 0
            ? null
            : new ClipboardReadError(
                "FAILED",
                `Clipboard reader exited with code ${code}; no credential was registered.`,
              ),
        ),
      )
    })
  }
}
