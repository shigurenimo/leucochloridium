import { describe, expect, it } from "vitest"
import { COMMANDS } from "@/cli/command-catalog"
import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { renderCliHelp } from "@/cli/render-cli-help"

describe("executable CLI documentation", () => {
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
    expect(specification.invariants.join(" ")).toContain("No automatic retry")
    expect(
      specification.commands.every(
        (entry) => entry.description && entry.result && entry.examples.length,
      ),
    ).toBe(true)
  })
  it("selects command groups and rejects guessed paths", () => {
    expect(getCliSpecification(["slack"]).commands).toHaveLength(5)
    expect(() => getCliSpecification(["projects"])).toThrow("Unknown help")
    expect(() => renderCliHelp(["not-real"])).toThrow("Unknown help")
  })
})
