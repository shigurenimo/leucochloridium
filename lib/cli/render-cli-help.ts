import { COMMANDS, GLOBAL_OPTIONS } from "@/cli/command-catalog"
import type { CommandDefinition, Parameter } from "@/cli/command-catalog"
import { CliError } from "@/cli/cli-error"

export function renderCliHelp(path: string[] = []): string {
  const requested = path.join(" ")
  const exact =
    COMMANDS.find((command) => command.name === requested) ??
    COMMANDS.find((command) => requested.startsWith(`${command.name} `))
  const commands = exact
    ? [exact]
    : COMMANDS.filter((command) => requested === "" || command.name.startsWith(`${requested} `))
  if (commands.length === 0) throw new CliError("USAGE", "Unknown help target. Run leuco --help.")
  const overview = [
    "leuco / one local Codex companion",
    "",
    "AI entrypoint: leuco --help; add --yaml or --json for structured details",
    "Results/errors are YAML by default; --json returns the same contract as JSON. Exit 0 = success; nonzero = failure.",
    "Run leuco <command> --help for required inputs, effects, prerequisites, results and retry notes.",
    "No terminal input prompts or stdin reads. Credential registration is clipboard-only; --foreground explicitly opts into a long-running daemon. Normal CLI deadline: 30000 ms; inspect state after timeout.",
    "-- ends flags. JSON values must be passed as one encoded argv value.",
    "",
    ...GLOBAL_OPTIONS.map((option) => `--${option.name}: ${option.description}`),
    "--version / -v: print CLI version without accessing state.",
    "",
  ]
  return [
    ...overview,
    ...commands.flatMap((command) =>
      exact
        ? renderCommand(command)
        : [
            `leuco ${command.name}${command.arguments.map((argument) => ` ${argument.required ? "<" : "["}${argument.name}${argument.variadic ? "..." : ""}${argument.required ? ">" : "]"}`).join("")}`,
            `  ${command.description}`,
            "",
          ],
    ),
    "Full contracts and setting schemas: leuco <command> --help --json",
    "LEUCO_HOME defaults to ~/.leuco. CODEX_HOME is inherited unchanged.",
    "",
  ].join("\n")
}
function renderCommand(command: CommandDefinition): string[] {
  const usage = `leuco ${command.name}${command.arguments.map((argument) => ` ${argument.required ? "<" : "["}${argument.name}${argument.variadic ? "..." : ""}${argument.required ? ">" : "]"}`).join("")}${command.options.length ? " [options]" : ""}`
  return [
    usage,
    `  ${command.description}`,
    `  Effect: ${command.effect}; daemon: ${command.daemon}.`,
    ...command.arguments.map((parameter) => `  Argument ${describe(parameter)}`),
    ...command.options.map((parameter) => `  --${describe(parameter)}`),
    `  Result: ${command.result}`,
    ...command.notes.map((note) => `  Note: ${note}`),
    ...command.examples.map((example) => `  Example: leuco ${example.map(shellQuote).join(" ")}`),
    "",
  ]
}
function describe(parameter: Parameter): string {
  return `${parameter.name} (${parameter.type}${parameter.required ? ", required" : ", optional"}${parameter.default === undefined ? "" : `, default ${parameter.default}`}${parameter.minimum === undefined ? "" : `, min ${parameter.minimum}`}${parameter.maximum === undefined ? "" : `, max ${parameter.maximum}`}): ${parameter.description}${parameter.choices ? ` Choices: ${parameter.choices.join(", ")}.` : ""}`
}
function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`
}
