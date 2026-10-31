import { expect, it } from "vitest"
import { parseArguments } from "@/cli/parse-arguments"
import { validateCommand } from "@/cli/validate-command"
import { getCliSpecification } from "@/cli/get-cli-specification"
import { renderCliHelp } from "@/cli/render-cli-help"

it("publishes the actual safe integer range for event timestamps", () => {
  const specification = getCliSpecification(["events"])
  expect(
    specification.commands[0]?.options.find((option) => option.name === "since"),
  ).toMatchObject({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  expect(renderCliHelp(["events"])).toContain("min 0, max 9007199254740991")
})

it.each(["0", "9007199254740991"])("accepts the event timestamp boundary %s", (value) => {
  expect(() => validateCommand(parseArguments(["events", "--since", value]))).not.toThrow()
})

it.each(["-1", "9007199254740992", "9007199254740993", "1.5", "1e3", "Infinity"])(
  "reports a concrete correction range for the invalid event timestamp %s",
  (value) => {
    expect(() => validateCommand(parseArguments(["events", "--since", value]))).toThrow(
      "since must be an integer from 0 to 9007199254740991",
    )
  },
)
