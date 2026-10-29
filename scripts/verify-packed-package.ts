import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const repositoryRoot = resolve(import.meta.dir, "..")
const workspace = mkdtempSync(join(tmpdir(), "leuco-package-"))
const packageDirectory = join(workspace, "package")
const consumerDirectory = join(workspace, "consumer")

function run(command: string[], cwd: string, env = process.env): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  })
  const stderr = result.stderr.toString()
  const stdout = result.stdout.toString()
  if (result.exitCode !== 0) {
    throw new Error(
      [`Command failed: ${command.join(" ")}`, stdout.trim(), stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    )
  }
  return stdout
}

try {
  mkdirSync(packageDirectory)
  mkdirSync(consumerDirectory)

  const packOutput = run(
    [process.execPath, "pm", "pack", "--destination", packageDirectory, "--quiet"],
    repositoryRoot,
  )
  const reportedTarball = packOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1)
  if (!reportedTarball) throw new Error("bun pm pack did not report a tarball")

  const tarball = isAbsolute(reportedTarball)
    ? reportedTarball
    : join(packageDirectory, reportedTarball)
  if (!existsSync(tarball)) throw new Error(`Packed tarball does not exist: ${tarball}`)

  writeFileSync(
    join(consumerDirectory, "package.json"),
    JSON.stringify({ name: "leuco-package-consumer", private: true, type: "module" }, null, 2),
  )
  run([process.execPath, "add", tarball], consumerDirectory)

  writeFileSync(
    join(consumerDirectory, "index.ts"),
    [
      'import { LeucoRuntime, type LeucoRuntimeProps } from "leuco"',
      "",
      "const runtimeProps = undefined as unknown as LeucoRuntimeProps",
      "void runtimeProps",
      'if (typeof LeucoRuntime !== "function") throw new Error("LeucoRuntime export is missing")',
      "",
    ].join("\n"),
  )
  writeFileSync(
    join(consumerDirectory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          lib: ["ESNext"],
          module: "Preserve",
          moduleResolution: "bundler",
          noEmit: true,
          skipLibCheck: true,
          strict: true,
          target: "ESNext",
        },
        include: ["index.ts"],
      },
      null,
      2,
    ),
  )

  run(
    [join(repositoryRoot, "node_modules/.bin/tsc"), "-p", "tsconfig.json", "--pretty", "false"],
    consumerDirectory,
  )
  run(
    [
      process.execPath,
      "-e",
      'import("leuco").then((module) => { if (typeof module.LeucoRuntime !== "function") process.exit(1) })',
    ],
    consumerDirectory,
  )
  const installedCli = join(consumerDirectory, "node_modules/leuco/lib/index.ts")
  if (!existsSync(join(consumerDirectory, "node_modules/leuco/skills/leuco-cli/SKILL.md")))
    throw new Error("Packed CLI skill is missing")
  const help = run([process.execPath, installedCli, "--help"], consumerDirectory)
  if (!help.includes("one local Codex companion")) throw new Error("Packed CLI help is stale")
  const machineHelp = JSON.parse(
    run([process.execPath, installedCli, "slack", "call", "--help", "--json"], consumerDirectory),
  )
  if (machineHelp.commands.length !== 1 || machineHelp.commands[0].name !== "slack call")
    throw new Error("Packed command help is not discoverable")
  if (!existsSync(join(consumerDirectory, "node_modules/leuco/CLI.md")))
    throw new Error("Packed CLI documentation is missing")

  const fakeCodex = join(workspace, "fake-codex")
  writeFileSync(
    fakeCodex,
    `#!/bin/sh\nexec '${process.execPath}' '${join(repositoryRoot, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
    { mode: 0o700 },
  )
  const reply = run(
    [
      process.execPath,
      installedCli,
      "run",
      "--codex-bin",
      fakeCodex,
      "--prompt",
      "hello",
      "--json",
    ],
    consumerDirectory,
    {
      ...process.env,
      LEUCO_HOME: join(workspace, "leuco"),
      CODEX_HOME: join(workspace, "codex"),
      LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
    },
  )
  const result = JSON.parse(reply)
  if (result.ok !== true || result.command !== "run" || result.data.reply !== "verified reply")
    throw new Error("Packed CLI could not complete a JSON-mode turn")
} finally {
  rmSync(workspace, { force: true, recursive: true })
}
