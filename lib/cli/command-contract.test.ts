import { describe, expect, it } from "vitest"
import { COMMANDS } from "@/cli/command-catalog"
import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { renderCliHelp } from "@/cli/render-cli-help"

describe("executable CLI documentation", () => {
  it("publishes foreground as required for run", () => {
    const run = getCliSpecification(["run"]).commands[0]
    expect(run?.options.find((option) => option.name === "foreground")?.required).toBe(true)
    expect(renderCliHelp(["run"])).toContain("--foreground (boolean, required)")
    expect(renderCliHelp()).toContain("leuco run --foreground")
    expect(renderCliHelp(["run"])).toContain("leuco run --foreground")
    expect(renderCliHelp()).toContain("leuco slack call <method> --body <body>")
  })
  it.each<[string, string[]]>([
    ["slack login", []],
    ["status", []],
    ["ask", []],
    ["config set", ["settings"]],
    ["config show", ["settings"]],
    ["schedules list", ["schedule"]],
    ["events", ["event"]],
    ["doctor", ["event"]],
  ])("publishes only relevant schemas for %s", (command, schemas) => {
    expect(Object.keys(getCliSpecification(command.split(" ")).inputSchemas)).toEqual(schemas)
  })
  it("retains every schema in the full specification", () => {
    expect(Object.keys(getCliSpecification().inputSchemas)).toEqual([
      "event",
      "settings",
      "schedule",
    ])
  })
  for (const definition of COMMANDS) {
    it(`accepts every published argv example for ${definition.name}`, () => {
      for (const example of definition.examples)
        expect(() => validateCommand(parseArguments(example))).not.toThrow()
      expect(
        getCliSpecification(definition.name.split(" ")).commands.map((entry) => entry.name),
      ).toContain(definition.name)
      expect(renderCliHelp(definition.name.split(" "))).toContain(definition.description)
    })
    for (const parameter of definition.options.filter((option) => option.required)) {
      it(`requires ${definition.name} --${parameter.name} as documented`, () => {
        const example = definition.examples.find((entry) => entry.includes(`--${parameter.name}`))!
        const index = example.indexOf(`--${parameter.name}`)
        const without = [...example.slice(0, index), ...example.slice(index + 2)]
        expect(() => validateCommand(parseArguments(without))).toThrow(
          `--${parameter.name} is required`,
        )
      })
    }
  }
  it("rejects typed input errors before dispatch", () => {
    for (const args of [
      ["logs", "--limit", "0"],
      ["logs", "--limit", "10001"],
      ["events", "--limit", "1e2"],
      ["slack", "call", "chat.postMessage", "--body", "[]"],
      ["config", "set", "projects", "[]"],
      ["schema"],
      ["run", "--thread", "notes"],
    ])
      expect(() => validateCommand(parseArguments(args))).toThrow()
  })
  it("keeps human-only login explicit and all mutation retry rules visible", () => {
    const specification = getCliSpecification()
    expect(specification.commands.find((entry) => entry.name === "slack login")?.automation).toBe(
      "human-required",
    )
    expect(specification.invariants.join(" ")).toContain("No automatic replay")
    expect(
      specification.commands.every(
        (entry) => entry.description && entry.result && entry.examples.length,
      ),
    ).toBe(true)
  })
  it("selects command groups and rejects guessed paths", () => {
    expect(getCliSpecification(["slack"]).commands).toHaveLength(5)
    for (const group of ["config", "schedules", "session"]) {
      const commands = getCliSpecification([group]).commands
      expect(commands.map((entry) => entry.name)).toEqual(
        COMMANDS.filter((entry) => entry.name.startsWith(`${group} `)).map((entry) => entry.name),
      )
      for (const command of commands) expect(renderCliHelp([group])).toContain(command.name)
    }
    expect(() => getCliSpecification(["projects"])).toThrow("Unknown help")
    expect(() => renderCliHelp(["not-real"])).toThrow("Unknown help")
  })
})
