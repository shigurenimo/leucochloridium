import { factory } from "@/cli/cli-factory"
import { flagBool, readCliBody } from "@/cli/utils/read-cli-body"

export const groupHelpHandler = (help: string) =>
  factory.createHandlers(async (c) => {
    const body = await readCliBody(c)

    if (flagBool(body.flags.help)) return c.text(help)

    return c.text(`leuco: missing subcommand\n\n${help}`, 400)
  })
