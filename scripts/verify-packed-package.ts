import { redactPublicText } from "@/secrets/redact-public-text"
import { truncateDiagnosticText } from "@/truncate-diagnostic-text"
import { z } from "zod"
import {
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { tmpdir } from "node:os"

const repositoryRoot = resolve(import.meta.dir, "..")
const workspace = mkdtempSync(join(tmpdir(), "leuco-package-"))
const packageDirectory = join(workspace, "package")
const consumerDirectory = join(workspace, "consumer")
const packageMetadata = z
  .object({
    devDependencies: z.object({ "@types/bun": z.string() }),
    engines: z.object({ bun: z.string() }),
  })
  .parse(JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")))
const bunTypesVersion = packageMetadata.devDependencies["@types/bun"]

function run(command: string[], cwd: string, env = process.env): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
    timeout: 60_000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
  })
  const stderr = result.stderr.toString()
  const stdout = result.stdout.toString()
  if (!result.success) {
    throw new Error(
      [
        `Command failed: ${command.join(" ")}; exitCode=${result.exitCode}, signal=${result.signalCode}, timeoutMs=60000, maxBufferBytes=4194304`,
        truncateDiagnosticText(redactPublicText(stdout.trim()), 16000),
        truncateDiagnosticText(redactPublicText(stderr.trim()), 16000),
      ]
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
    JSON.stringify(
      {
        name: "leuco-package-consumer",
        private: true,
        type: "module",
        devDependencies: { "@types/bun": bunTypesVersion },
      },
      null,
      2,
    ),
  )
  run([process.execPath, "add", tarball], consumerDirectory)
  const installedPackage = join(consumerDirectory, "node_modules/leuco")
  for (const document of [
    "README.md",
    "CLI.md",
    "SECURITY.md",
    "skills/leuco-cli/SKILL.md",
    ".docs/reliability.md",
    ".docs/reliability-design.md",
    ".docs/reliability-verification.md",
  ]) {
    const path = join(installedPackage, document)
    if (!existsSync(path)) throw new Error(`Required package document is missing: ${document}`)
    for (const match of readFileSync(path, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
      const target = match[1]!.split("#")[0]!
      if (!target || /^[a-zA-Z][\w+.-]*:/.test(target)) continue
      if (!existsSync(resolve(dirname(path), target)))
        throw new Error(`Broken packaged document link: ${document} -> ${target}`)
    }
  }
  const developmentFiles = readdirSync(installedPackage, { recursive: true, encoding: "utf8" })
    .map((path) => path.replaceAll("\\", "/"))
    .filter(
      (path) =>
        /\.(?:bun-)?test\.ts$/.test(path) ||
        (!path.includes("/event-log/") &&
          /(?:^|\/)(?:(?:leuco-)?memory-[^/]+|render-cli-docs)\.(?:d\.)?ts$/.test(path)),
    )
  if (developmentFiles.length > 0)
    throw new Error(`Development-only files were shipped: ${developmentFiles.join(", ")}`)

  writeFileSync(
    join(consumerDirectory, "index.ts"),
    [
      'import { LeucoRuntime, type LeucoRuntimeProps, type SlackCommandOptions } from "leuco"',
      "",
      "const runtimeProps: LeucoRuntimeProps = { cwd: '/workspace' }",
      "void runtimeProps",
      "const slackOptions: SlackCommandOptions = { requestId: 'package-typecheck' }",
      "const checkSlackOptions = (runtime: LeucoRuntime): Promise<unknown> => runtime.runSlackCommand({ words: ['slack', 'call', 'auth.test'], flags: { body: '{}' } }, slackOptions)",
      "void checkSlackOptions",
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
          skipLibCheck: false,
          types: ["bun"],
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
  run(
    [
      process.execPath,
      "-e",
      `Bun.semver.satisfies=()=>false;await import("leuco").then(()=>{throw new Error("Unsupported Bun was accepted")},error=>{if(!error.message.includes(${JSON.stringify(`Bun ${packageMetadata.engines.bun} is required`)}))throw error})`,
    ],
    consumerDirectory,
  )
  const node = Bun.which("node")
  if (node !== null) {
    for (const source of [
      'import("leuco")',
      'import { LeucoRuntime } from "leuco"; void LeucoRuntime',
    ]) {
      const rejected = Bun.spawnSync([node, "--input-type=module", "-e", source], {
        cwd: consumerDirectory,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 15000,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
      })
      const diagnostic = rejected.stderr.toString()
      if (
        rejected.exitCode !== 1 ||
        rejected.stdout.length !== 0 ||
        !diagnostic.includes("leuco is Bun-only.")
      )
        throw new Error(
          `Node import did not report Bun guidance (exit=${rejected.exitCode}, signal=${rejected.signalCode}): ${truncateDiagnosticText(redactPublicText(diagnostic), 4000)}`,
        )
    }
  }
  const installedCli = join(consumerDirectory, "node_modules/leuco/lib/index.ts")
  const help = run([process.execPath, installedCli, "--help"], consumerDirectory)
  if (!help.includes("one local Codex companion")) throw new Error("Packed CLI help is stale")
  const machineHelp = JSON.parse(
    run([process.execPath, installedCli, "slack", "call", "--help", "--json"], consumerDirectory),
  )
  if (machineHelp.commands.length !== 1 || machineHelp.commands[0].name !== "slack call")
    throw new Error("Packed command help is not discoverable")

  const fakeBin = join(workspace, "bin")
  mkdirSync(fakeBin)
  const fakeCodex = join(fakeBin, "codex")
  writeFileSync(
    fakeCodex,
    `#!/bin/sh\nexec '${process.execPath}' '${join(repositoryRoot, "scripts/fixtures/fake-codex.ts")}' "$@"\n`,
    { mode: 0o700 },
  )
  const executionEnvironment = {
    ...process.env,
    PATH: fakeBin,
    LEUCO_HOME: join(workspace, "leuco"),
    CODEX_HOME: join(workspace, "codex"),
    LEUCO_VERIFY_TRACE: join(workspace, "trace.jsonl"),
  }
  run([process.execPath, installedCli, "start", "--json"], consumerDirectory, executionEnvironment)
  const reply = (() => {
    try {
      return run(
        [process.execPath, installedCli, "ask", "hello", "--json"],
        consumerDirectory,
        executionEnvironment,
      )
    } finally {
      run(
        [process.execPath, installedCli, "stop", "--json"],
        consumerDirectory,
        executionEnvironment,
      )
    }
  })()
  const libraryOutput = run(
    [
      process.execPath,
      "-e",
      [
        "const hostCwd = process.cwd()",
        "const hostEnvironment = JSON.stringify(process.env)",
        "const hostExitCode = process.exitCode",
        'const hostEvents = ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]',
        "const hostHandlers = hostEvents.map(event => process.listeners(event))",
        'const library = await import("leuco")',
        "const codexBin = process.env.LEUCO_VERIFY_CODEX",
        'if (!codexBin) throw new Error("Missing isolated fake Codex")',
        "const runtime = library.LeucoRuntime.build({ codexBin })",
        "const timeout = setTimeout(() => process.exit(2), 15000)",
        "try {",
        "  await runtime.start()",
        '  const reply = await runtime.runTextTurn("cli", "memory history", "packed-memory")',
        "  if (reply instanceof Error) throw reply",
        '  const events = runtime.getVolatileEvents({ requestId: "packed-memory", type: "turn.complete", limit: 1 })',
        "  const logs = runtime.getStatus().logs",
        '  if (events.length !== 1 || logs.mode !== "memory" || logs.durable || logs.memoryWrites < 1) throw new Error("Packed library memory diagnostics are inconsistent")',
        "} finally { await runtime.stop(); clearTimeout(timeout) }",
        'if (process.cwd() !== hostCwd || JSON.stringify(process.env) !== hostEnvironment || process.exitCode !== hostExitCode) throw new Error("Library changed host process settings")',
        "for (const index of hostEvents.keys()) {",
        "  const handlers = process.listeners(hostEvents[index])",
        '  if (handlers.length !== hostHandlers[index].length || handlers.some((handler, position) => handler !== hostHandlers[index][position])) throw new Error("Library changed host process handlers")',
        "}",
        'console.log("library-host-survived")',
      ].join("\n"),
    ],
    consumerDirectory,
    {
      ...process.env,
      LEUCO_HOME: join(workspace, "library-home"),
      CODEX_HOME: join(workspace, "library-codex"),
      LEUCO_VERIFY_CODEX: fakeCodex,
      LEUCO_VERIFY_TRACE: join(workspace, "library-trace.jsonl"),
    },
  )
  if (libraryOutput !== "library-host-survived\n")
    throw new Error("Packed library did not return control to its host")
  const installedVersion = z
    .object({ version: z.string() })
    .parse(
      JSON.parse(readFileSync(join(consumerDirectory, "node_modules/leuco/package.json"), "utf8")),
    ).version
  const initializeSchema = z.object({
    method: z.literal("initialize"),
    params: z.object({ clientInfo: z.object({ version: z.string() }) }),
  })
  for (const trace of ["trace.jsonl", "library-trace.jsonl"]) {
    const initialized = readFileSync(join(workspace, trace), "utf8")
      .trim()
      .split("\n")
      .map((line) => initializeSchema.safeParse(JSON.parse(line)))
      .find((frame) => frame.success)
    if (!initialized?.success || initialized.data.params.clientInfo.version !== installedVersion)
      throw new Error(`Packed Codex client version differs from its package: ${trace}`)
  }
  const result = JSON.parse(reply)
  if (result.ok !== true || result.command !== "ask" || result.data.reply !== "verified reply")
    throw new Error("Packed CLI could not complete a JSON-mode turn")
} finally {
  rmSync(workspace, { force: true, recursive: true })
}
