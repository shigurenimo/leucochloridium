import type { CommandDefinition } from "@/cli/command-catalog"

export function renderCommandUsage(command: CommandDefinition): string {
  const argumentsUsage = command.arguments.map(
    (argument) =>
      ` ${argument.required ? "<" : "["}${argument.name}${argument.variadic ? "..." : ""}${argument.required ? ">" : "]"}`,
  )
  const requiredOptions = command.options
    .filter((option) => option.required)
    .map((option) => ` --${option.name}${option.type === "boolean" ? "" : ` <${option.name}>`}`)
  const optionalOptions = command.options.some((option) => !option.required) ? " [options]" : ""
  return `leuco ${command.name}${argumentsUsage.join("")}${requiredOptions.join("")}${optionalOptions}`
}
