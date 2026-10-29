import type { CliArguments } from "@/cli/parse-arguments"
import { GLOBAL_OPTIONS } from "@/cli/command-catalog"
import type { Parameter } from "@/cli/command-catalog"
import { resolveCommand } from "@/cli/resolve-command"
import { CliError } from "@/cli/cli-error"

export function validateCommand(parsed: CliArguments): void {
  const resolved = resolveCommand(parsed.words)
  const definition = resolved.definition
  const parameters = [...definition.options, ...GLOBAL_OPTIONS]
  for (const name of Object.keys(parsed.flags)) {
    const parameter = parameters.find((entry) => entry.name === name)
    if (parameter === undefined)
      throw new CliError(
        "USAGE",
        `--${name} is not supported by ${definition.name}. Run leuco ${definition.name} --help`,
      )
    validateParameter(parameter, parsed.flags[name])
    if (parameter.conflicts?.some((other) => parsed.flags[other] !== undefined))
      throw new CliError("USAGE", `--${name} conflicts with another supplied option`)
  }
  for (const parameter of definition.options)
    if (parameter.required && parsed.flags[parameter.name] === undefined)
      throw new CliError("USAGE", `--${parameter.name} is required by ${definition.name}`)
  if (definition.name === "run" && parsed.flags.prompt === undefined && !parsed.flags.foreground)
    throw new CliError(
      "USAGE",
      "run requires --prompt for one-shot execution, or explicit --foreground for a human-managed daemon. Automation should use start.",
    )
  if (definition.name === "config set" && resolved.arguments[1] === "-")
    throw new CliError(
      "USAGE",
      "stdin input is disabled; pass the JSON setting value as an argument",
    )
  const minimum = definition.arguments.filter((entry) => entry.required).length
  const maximum = definition.arguments.some((entry) => entry.variadic)
    ? Infinity
    : definition.arguments.length
  if (resolved.arguments.length < minimum || resolved.arguments.length > maximum)
    throw new CliError(
      "USAGE",
      `Invalid positional arguments for ${definition.name}. Run leuco ${definition.name} --help`,
    )
  for (const [index, parameter] of definition.arguments.entries())
    if (resolved.arguments[index] !== undefined)
      validateParameter(parameter, resolved.arguments[index])
  if (
    definition.name === "run" &&
    parsed.flags.thread !== undefined &&
    parsed.flags.prompt === undefined
  )
    throw new CliError("USAGE", "run --thread requires --prompt")
}

function validateParameter(parameter: Parameter, value: string | true | undefined): void {
  if (parameter.type === "boolean") {
    if (value !== true) throw new CliError("USAGE", `--${parameter.name} takes no value`)
    return
  }
  if (typeof value !== "string" || value.length === 0)
    throw new CliError("USAGE", `${parameter.name} requires a value`)
  if (parameter.pattern && !new RegExp(parameter.pattern).test(value))
    throw new CliError("USAGE", `Invalid ${parameter.name}; expected ${parameter.pattern}`)
  if (parameter.maxLength !== undefined && value.length > parameter.maxLength)
    throw new CliError("USAGE", `${parameter.name} is too long`)
  if (parameter.choices && !parameter.choices.includes(value))
    throw new CliError("USAGE", `Unsupported ${parameter.name}; inspect leuco --help --json`)
  if (parameter.type === "integer") {
    const number = Number(value)
    if (
      !/^[0-9]+$/.test(value) ||
      !Number.isSafeInteger(number) ||
      number < (parameter.minimum ?? -Infinity) ||
      number > (parameter.maximum ?? Infinity)
    )
      throw new CliError(
        "USAGE",
        `${parameter.name} must be an integer from ${parameter.minimum} to ${parameter.maximum}`,
      )
  }
  if ((parameter.type === "json" && value !== "-") || parameter.type === "json-object") {
    try {
      const decoded: unknown = JSON.parse(value)
      if (
        parameter.type === "json-object" &&
        (decoded === null || typeof decoded !== "object" || Array.isArray(decoded))
      )
        throw new Error("object required")
    } catch {
      throw new CliError(
        "USAGE",
        `${parameter.name} requires valid ${parameter.type === "json-object" ? "JSON object" : "JSON"}`,
      )
    }
  }
}
