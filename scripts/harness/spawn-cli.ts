import { resolve } from "node:path"

type Props = {
  args: ReadonlyArray<string>
  env: NodeJS.ProcessEnv
  cwd?: string
  stdin?: "ignore" | "pipe"
}

const executable = resolve(import.meta.dir, "..", "..", "lib", "index.ts")

export function spawnCli(props: Props) {
  return Bun.spawn([process.execPath, executable, ...props.args], {
    cwd: props.cwd,
    env: props.env,
    stdin: props.stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}
